import * as NodeFSP from 'node:fs/promises'
import * as NodeCrypto from 'node:crypto'
import { Schema } from 'effect'
import { chromium } from 'playwright-core'

// This is the private one-step driver protocol, mapped exhaustively from the product contract.
const BrowserStep = Schema.Union([
  Schema.Struct({ step: Schema.tag('open'), address: Schema.String }),
  Schema.Struct({ step: Schema.tag('read') }),
  Schema.Struct({ step: Schema.tag('click'), target: Schema.String }),
  Schema.Struct({ step: Schema.tag('type'), target: Schema.String, text: Schema.String }),
  Schema.Struct({ step: Schema.tag('press'), key: Schema.String }),
  Schema.Struct({ step: Schema.tag('screenshot') }),
]).pipe(Schema.toTaggedUnion('step'))
const decodeStep = Schema.decodeUnknownSync(Schema.fromJsonString(BrowserStep))

const outlineBudget = 32_768

/**
 * Attach to the persistent browser and expose the newest tab on the desktop before acting.
 * This follows the profile/takeover evidence in docs/21-reference-mining.md; disconnect leaves Chromium alive.
 */
async function connect() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const context = browser.contexts()[0]
  if (context === undefined) throw new Error('Browser context is absent.')
  const pages = context.pages()
  const page = pages[pages.length - 1]
  if (page === undefined) throw new Error('Browser page is absent.')
  await page.bringToFront()
  const session = await context.newCDPSession(page)
  const { targetInfo } = await session.send('Target.getTargetInfo')
  const { frameTree } = await session.send('Page.getFrameTree')
  return {
    browser,
    page,
    session,
    tab: targetInfo.targetId,
    target: `${targetInfo.targetId}.${frameTree.frame.loaderId}`,
  }
}

/** Backend-node identity remains stable across reads; tab/document-qualified refs refuse navigation-stale actions. */
function nodeReference(target, node) {
  return `e${target}:${node}`
}

/** Parse only our opaque references, never selectors or scripts suggested by untrusted page content. */
function referencedNode(target, reference) {
  const match = /^e([a-fA-F0-9]+\.[a-fA-F0-9]+):(\d+)$/.exec(reference)
  if (match === null || match[1] !== target || match[2] === undefined) {
    throw new Error('Read the page again to obtain a current element reference.')
  }
  return Number(match[2])
}

/** Use the accessibility tree rather than raw DOM; page code never becomes driver code. */
async function outline(connection) {
  const { frameTree } = await connection.session.send('Page.getFrameTree')
  const target = `${connection.tab}.${frameTree.frame.loaderId}`
  const { nodes } = await connection.session.send('Accessibility.getFullAXTree')
  const after = await connection.session.send('Page.getFrameTree')
  if (after.frameTree.frame.loaderId !== frameTree.frame.loaderId) {
    throw new Error('The page navigated during the read; read it again.')
  }
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const lines = []
  const roots = nodes.filter((node) => node.parentId === undefined)
  for (const root of roots) appendNode(target, root, { byId, lines }, 0)
  const text = lines.join('\n')
  const bytes = Buffer.from(text)
  const truncated = bytes.length > outlineBudget
  const visible = new TextDecoder().decode(bytes.subarray(0, outlineBudget), { stream: truncated })
  return { outline: truncated ? `${visible}\n[outline truncated]` : text, truncated }
}

/** Preserve hierarchy and visible role/name/value semantics without exposing DOM attributes or markup. */
function appendNode(target, node, tree, depth) {
  if (node.ignored !== true) {
    const role = node.role === undefined ? '' : String(node.role.value)
    const name = node.name === undefined ? '' : String(node.name.value)
    const value = node.value === undefined ? '' : String(node.value.value)
    const ref =
      node.backendDOMNodeId === undefined
        ? ''
        : `[${nodeReference(target, node.backendDOMNodeId)}] `
    tree.lines.push(
      `${'  '.repeat(Math.min(depth, 16))}${ref}${role} ${JSON.stringify(name)} ${value}`.trimEnd(),
    )
  }
  if (node.childIds === undefined) return
  for (const id of node.childIds) {
    const child = tree.byId.get(id)
    if (child !== undefined) appendNode(target, child, tree, depth + 1)
  }
}

/** Click through CDP geometry, never Runtime.evaluate or page-provided JavaScript. */
async function click(connection, target) {
  const backendNodeId = referencedNode(connection.target, target)
  await connection.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const { model } = await connection.session.send('DOM.getBoxModel', { backendNodeId })
  const x = (model.content[0] + model.content[4]) / 2
  const y = (model.content[1] + model.content[5]) / 2
  await connection.page.mouse.click(x, y)
}

/** Focus the referenced node and insert literal text, including passwords, without logging its content. */
async function type(connection, action) {
  const backendNodeId = referencedNode(connection.target, action.target)
  await connection.session.send('DOM.focus', { backendNodeId })
  await connection.page.keyboard.press('Control+A')
  await connection.page.keyboard.insertText(action.text)
}

/** Each process handles exactly one allowed step and returns the contract's post-action page facts. */
async function step(connection, action) {
  return BrowserStep.match(action, {
    open: async ({ address }) => {
      const url = new URL(address)
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Only web addresses are allowed.')
      await connection.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return snapshot(connection)
    },
    read: () => snapshot(connection),
    click: async ({ target }) => {
      await click(connection, target)
      return snapshot(connection)
    },
    type: async (input) => {
      await type(connection, input)
      return snapshot(connection)
    },
    press: async ({ key }) => {
      await connection.page.keyboard.press(key)
      return snapshot(connection)
    },
    screenshot: async () => {
      const directory = '/home/vivid/.vivid/screens'
      await NodeFSP.mkdir(directory, { recursive: true })
      const path = `${directory}/${NodeCrypto.randomUUID()}.png`
      await connection.page.screenshot({ path, type: 'png' })
      return {
        address: connection.page.url(),
        title: await connection.page.title(),
        outline: `Screenshot saved to ${path}`,
        truncated: false,
      }
    },
  })
}

/** Every ordinary action returns post-action accessibility facts through one result projection. */
async function snapshot(connection) {
  const content = await outline(connection)
  return {
    address: connection.page.url(),
    title: await connection.page.title(),
    outline: content.outline,
    truncated: content.truncated,
  }
}

/** CDP is a third-party Promise adapter; failures emit a fixed diagnostic without leaking page or input data. */
async function main() {
  const action = decodeStep(process.argv[2])
  const connection = await connect()
  await step(connection, action).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write('Browser step failed.\n')
      process.exitCode = 1
    },
  )
  await connection.browser.close()
}

await main().catch(() => {
  process.stderr.write('Browser driver unavailable.\n')
  process.exitCode = 1
})

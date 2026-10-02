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
  Schema.Struct({
    step: Schema.tag('scroll'),
    direction: Schema.Literals(['up', 'down', 'left', 'right']),
    notches: Schema.Int,
  }),
  Schema.Struct({ step: Schema.tag('back') }),
  Schema.Struct({ step: Schema.tag('forward') }),
  Schema.Struct({ step: Schema.tag('wait'), seconds: Schema.Int }),
  Schema.Struct({ step: Schema.tag('openTab'), address: Schema.String }),
  Schema.Struct({ step: Schema.tag('showTab'), tab: Schema.Int }),
  Schema.Struct({ step: Schema.tag('closeTab'), tab: Schema.Int }),
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
  const saved = await NodeFSP.readFile('/home/vivid/.vivid/tab', 'utf8').then(
    (value) => value,
    (error) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  let page
  for (const candidate of pages) {
    const probe = await context.newCDPSession(candidate)
    const { targetInfo } = await probe.send('Target.getTargetInfo')
    await probe.detach()
    if (targetInfo.targetId === saved) page = candidate
  }
  if (page === undefined)
    page = pages.length === 0 ? await context.newPage() : pages[pages.length - 1]
  await page.bringToFront()
  const session = await context.newCDPSession(page)
  const { targetInfo } = await session.send('Target.getTargetInfo')
  const { frameTree } = await session.send('Page.getFrameTree')
  return {
    browser,
    context,
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

/** Human targets resolve to exactly one accessible name; existing private node references remain
 * accepted for the offline driver tests. Neither selectors nor page JavaScript are evaluated. */
async function targetNode(connection, target) {
  if (/^e[a-fA-F0-9]+\.[a-fA-F0-9]+:\d+$/.test(target))
    return referencedNode(connection.target, target)
  const { nodes } = await connection.session.send('Accessibility.getFullAXTree')
  const matches = nodes.filter(
    (node) =>
      node.ignored !== true &&
      node.name !== undefined &&
      node.name.value.toLocaleLowerCase() === target.toLocaleLowerCase() &&
      node.backendDOMNodeId !== undefined,
  )
  if (matches.length !== 1) throw new Error('The page target is missing or ambiguous.')
  return matches[0].backendDOMNodeId
}

/** Tab selection updates the one post-action projection and the next process's durable selection. */
async function selectPage(connection, page) {
  await connection.session.detach()
  connection.page = page
  await page.bringToFront()
  connection.session = await connection.context.newCDPSession(page)
  const { targetInfo } = await connection.session.send('Target.getTargetInfo')
  const { frameTree } = await connection.session.send('Page.getFrameTree')
  connection.tab = targetInfo.targetId
  connection.target = `${targetInfo.targetId}.${frameTree.frame.loaderId}`
}

/** Click through CDP geometry, never Runtime.evaluate or page-provided JavaScript. */
async function click(connection, target) {
  const backendNodeId = await targetNode(connection, target)
  await connection.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const { model } = await connection.session.send('DOM.getBoxModel', { backendNodeId })
  const x = (model.content[0] + model.content[4]) / 2
  const y = (model.content[1] + model.content[5]) / 2
  await connection.page.mouse.click(x, y)
}

/** Focus the referenced node and insert literal text, including passwords, without logging its content. */
async function type(connection, action) {
  const backendNodeId = await targetNode(connection, action.target)
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
    scroll: async ({ direction, notches }) => {
      const amount = notches * 100
      await connection.page.mouse.wheel(
        direction === 'left' ? -amount : direction === 'right' ? amount : 0,
        direction === 'up' ? -amount : direction === 'down' ? amount : 0,
      )
      return snapshot(connection)
    },
    back: async () => {
      await connection.page.goBack()
      return snapshot(connection)
    },
    forward: async () => {
      await connection.page.goForward()
      return snapshot(connection)
    },
    wait: async ({ seconds }) => {
      await connection.page.waitForTimeout(seconds * 1000)
      return snapshot(connection)
    },
    openTab: async ({ address }) => {
      await selectPage(connection, await connection.context.newPage())
      await connection.page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30000 })
      return snapshot(connection)
    },
    showTab: async ({ tab }) => {
      const page = connection.context.pages()[tab - 1]
      if (page === undefined) throw new Error('The tab is absent.')
      await selectPage(connection, page)
      return snapshot(connection)
    },
    closeTab: async ({ tab }) => {
      const page = connection.context.pages()[tab - 1]
      if (page === undefined) throw new Error('The tab is absent.')
      await page.close()
      const pages = connection.context.pages()
      await selectPage(
        connection,
        pages.length === 0 ? await connection.context.newPage() : pages[0],
      )
      return snapshot(connection)
    },
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
      await retainScreens(directory)
      return {
        ...(await snapshot(connection)),
        address: connection.page.url(),
        title: await connection.page.title(),
        outline: `Screenshot saved to ${path}`,
        truncated: false,
      }
    },
  })
}

/** Bound durable screenshot storage by retaining the newest 50 PNG files, including the current receipt. */
async function retainScreens(directory) {
  const names = (await NodeFSP.readdir(directory)).filter((name) => name.endsWith('.png'))
  const files = []
  for (const name of names) {
    const path = `${directory}/${name}`
    files.push({ path, modified: (await NodeFSP.stat(path)).mtimeMs })
  }
  files.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path))
  for (const { path } of files.slice(50)) await NodeFSP.unlink(path)
}

/** Every ordinary action returns post-action accessibility facts through one result projection. */
async function snapshot(connection) {
  const content = await outline(connection)
  const tabs = []
  for (const page of connection.context.pages())
    tabs.push({ title: await page.title(), address: page.url(), showing: page === connection.page })
  await NodeFSP.mkdir('/home/vivid/.vivid', { recursive: true })
  await NodeFSP.writeFile('/home/vivid/.vivid/tab', connection.tab)
  return {
    address: connection.page.url(),
    title: await connection.page.title(),
    outline: content.outline,
    truncated: content.truncated,
    tabs,
  }
}

/** CDP is a third-party Promise adapter; failures emit a fixed diagnostic without leaking page or input data. */
async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const action = decodeStep(Buffer.concat(chunks).toString('utf8'))
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

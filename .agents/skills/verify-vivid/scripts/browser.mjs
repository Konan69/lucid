import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { command, json, identity, alive } from './process.mjs'
import { control } from './socket.mjs'
import { rpc, settled, history } from './wire.mjs'
import { features } from './drive.mjs'

const missing = {
  question: 'No browser recipe for the multi-question controls yet',
  picture: 'No browser recipe for the composer file input yet',
  approve: 'No connected disposable Integration to produce a pending Approval',
  deny: 'No connected disposable Integration to produce a pending Approval',
  stop: 'No reproducible active Run recipe yet',
  code: 'No disposable Person Computer authority',
  watch: 'No disposable Integration with incoming events',
  library: 'No browser ingestion recipe yet',
  feed: 'No disposable Watch occurrence',
}
const recipes = {
  first: { phrase: 'Hello Vivid. Reply with one short sentence.', check: 'reply' },
  reload: { phrase: 'Hello Vivid. Reply with one short sentence.', check: 'reload' },
  tool: {
    phrase:
      'Show a rich interactive table using an openui-lang Table, not Markdown. Columns Project, Hours, Owner. Rows Research | 4 | Ada, Writing | 3 | Ben, Review | 2 | Cai. Title Workload.',
    rehearsal: 'show a table',
    check: 'table',
  },
  document: {
    phrase:
      'Use write_document to create one document titled Verification plan with body # Verification plan\nResearch, writing and review. Only write this one document.',
    rehearsal: 'write a document',
    check: 'document',
  },
}
for (const name of features)
  assert.ok(recipes[name] || missing[name], 'Unmapped browser feature ' + name)

/** The checks use rendered semantic elements. Raw source or assistant prose cannot satisfy them. */
async function rendered(run, kind) {
  switch (kind) {
    case 'table': {
      await run(['wait', 'table'])
      const result = JSON.parse(
        await run([
          'eval',
          `JSON.stringify(Array.from(document.querySelectorAll('table')).map(t => ({ headers: Array.from(t.querySelectorAll('th')).map(c => c.textContent.trim()), rows: Array.from(t.querySelectorAll('tbody tr')).map(r => Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim())) })))`,
        ]),
      )
      const tables = typeof result === 'string' ? JSON.parse(result) : result
      const table = tables.find((t) =>
        ['Project', 'Hours', 'Owner'].every((h) => t.headers.includes(h)),
      )
      assert.ok(table, 'Rendered table lacks Project/Hours/Owner column headers')
      for (const row of ['Research', 'Writing', 'Review'])
        assert.ok(
          table.rows.some((r) => r.includes(row)),
          'Missing table row ' + row,
        )
      break
    }
    case 'document': {
      await run(['wait', 'button[aria-expanded]'])
      const snapshot = await run(['snapshot'])
      assert.match(snapshot, /button "Wrote a document/)
      await run(['find', 'role', 'button', 'click', '--name', 'Wrote a document', '--exact'])
      const expanded = await run(['snapshot'])
      assert.match(expanded, /listitem:[\s\S]*Wrote a document/)
      await run(['find', 'role', 'button', 'click', '--name', 'Wrote a document', '--exact'])
      break
    }
    case 'reply':
    case 'reload':
      break
    default:
      throw new Error('Unknown rendered assertion ' + kind)
  }
}

/** Read daemon identities from this run's private namespace, then capture its Chrome descendants. */
async function captureBrowser(receipt) {
  const roots = [
    receipt.socketDirectory,
    receipt.scratch + '/.agent-browser/namespaces/' + receipt.namespace,
  ]
  const processes = []
  async function capture(pid) {
    if (processes.some((p) => p.pid === pid)) return
    const owned = await identity(pid)
    processes.push(owned)
    const children = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim()
    for (const child of children.split(/\s+/).filter(Boolean)) await capture(Number(child))
  }
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = directory + '/' + entry.name
      if (entry.isDirectory()) await visit(file)
      else if (entry.name.endsWith('.pid')) {
        const text = (await fs.readFile(file, 'utf8')).trim()
        if (/^\d+$/.test(text)) await capture(Number(text))
      }
    }
  }
  for (const root of roots) await visit(root)
  receipt.processes = processes
  await json(receipt.scratch + '/browser.json', receipt)
}

export async function browser(state, feature) {
  const chosen = feature === 'all' ? features : [feature]
  if (chosen.some((f) => !features.includes(f)))
    throw new Error('Unknown browser feature ' + feature)
  for (const name of chosen) await journey(state, name)
}

async function journey(state, feature) {
  const directory = state.evidence + '/browser/' + feature
  await fs.mkdir(directory, { recursive: true })
  const base = {
    feature,
    head: state.head,
    dirty: state.dirty,
    tree: state.tree,
    model: state.model,
    modelKind: state.modelKind,
    host: state.hostname,
    evidence: directory,
  }
  if (missing[feature]) {
    const verdict = {
      ...base,
      verdict: 'blocked',
      reason: 'no browser recipe: ' + missing[feature],
    }
    await json(directory + '/verdict.json', verdict)
    console.log(JSON.stringify(verdict))
    process.exitCode = 1
    return
  }
  const account = JSON.parse(await fs.readFile(state.scratch + '/account.json', 'utf8'))
  const receipt = {
    executable: process.env.VIVID_VERIFY_BROWSER ?? 'agent-browser',
    namespace: 'v-' + state.run.slice(-8),
    session: 'v',
    scratch: state.scratch,
    socketDirectory: '/tmp/vivid-verify-' + state.run.slice(-8),
    profile: state.scratch + '/browser-profile',
    chrome: process.env.VIVID_VERIFY_CHROME ?? '/opt/google/chrome/chrome',
  }
  await json(state.scratch + '/browser.json', receipt)
  await fs.mkdir(receipt.socketDirectory, { mode: 0o700, recursive: true })
  let sequence = 0
  const run = (args) =>
    command(
      [
        receipt.executable,
        '--namespace',
        receipt.namespace,
        '--session',
        'v',
        '--profile',
        receipt.profile,
        '--executable-path',
        receipt.chrome,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: state.scratch,
          AGENT_BROWSER_SOCKET_DIR: receipt.socketDirectory,
          AGENT_BROWSER_DEFAULT_TIMEOUT: '120000',
        },
        log: directory + '/' + String(++sequence).padStart(2, '0') + '-' + args[0] + '.json',
        redactions: [account.password],
        record: (process) => control(state, { action: 'capture', process }),
      },
    )
  const capture = async (name) => {
    await fs.writeFile(directory + '/' + name + '.aria.txt', await run(['snapshot']))
    await run(['screenshot', directory + '/' + name + '.png', '--full'])
  }
  let verdict
  try {
    const id = crypto.randomUUID()
    await rpc(state, 'CreateThread', { id, title: 'Verify ' + feature, projectId: null }, directory)
    await json(directory + '/context.json', { thread: id, ...base })
    await run(['open', state.web + '/t/' + id])
    await captureBrowser(receipt)
    await run([
      'wait',
      '--fn',
      `document.querySelector('input[type=email]') || document.querySelector('[aria-label="Message Vivid"]')`,
    ])
    const welcome = await run(['snapshot', '-i'])
    if (welcome.includes('I already have an account'))
      await run(['find', 'text', 'I already have an account', 'click', '--exact'])
    if (welcome.includes('Email')) {
      await run(['find', 'label', 'Email', 'fill', account.email])
      await run(['find', 'label', 'Password', 'fill', account.password])
      await run(['find', 'role', 'button', 'click', '--name', 'Sign in', '--exact'])
    }
    await run(['wait', '[aria-label="Message Vivid"]'])
    await capture('before')
    const recipe = recipes[feature]
    const phrase =
      state.modelKind === 'rehearsal' && recipe.rehearsal ? recipe.rehearsal : recipe.phrase
    await run(['find', 'label', 'Message Vivid', 'fill', phrase])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    await settled(state, id, 1, 'Completed', directory)
    await run(['wait', '[aria-label="Message Vivid"]'])
    const page = await history(state, id, directory)
    const replies = page.messages.filter((m) => m.role === 'assistant')
    assert.ok(
      replies.some((m) => m.parts.some((p) => p.type === 'text' && p.text.trim())),
      'No assistant reply',
    )
    await rendered(run, recipe.check)
    await capture('after')
    await run(['reload'])
    await run(['wait', '[aria-label="Message Vivid"]'])
    if (recipe.check === 'reply' || recipe.check === 'reload') {
      const text = replies
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'text' && p.text.trim()).text
      await run(['wait', '--text', text])
    }
    await rendered(run, recipe.check)
    await capture('reloaded')
    const reloaded = await history(state, id, directory, 'reloaded-history')
    assert.equal(reloaded.messages.filter((m) => m.role === 'user').length, 1)
    if (feature === 'document') {
      const artifacts = await rpc(state, 'ListArtifacts', { threadId: id }, directory)
      assert.equal(artifacts.artifacts.length, 1)
      assert.equal(artifacts.artifacts[0].version, 1)
    }
    verdict = {
      ...base,
      verdict: state.modelKind === 'rehearsal' ? 'plumbing-only' : 'proved',
      thread: id,
      scope:
        feature === 'document'
          ? 'create, rendered tool card and reload; versioning needs feature document; no Artifact opener exists in web source'
          : 'send and rendered reply before and after reload',
    }
  } catch (error) {
    await run(['errors']).catch(() => {})
    await run(['console']).catch(() => {})
    await capture('failure').catch(() => {})
    verdict = { ...base, verdict: 'failed', error: error.stack }
    process.exitCode = 1
  } finally {
    try {
      await run(['close'])
      for (const owned of receipt.processes ?? [])
        assert.equal(await alive(owned), false, 'Browser process survived close ' + owned.pid)
      await json(directory + '/browser-processes.json', receipt.processes ?? [])
      await fs.rm(receipt.socketDirectory, { recursive: true, force: true })
      await fs.unlink(state.scratch + '/browser.json')
    } catch (error) {
      verdict = { ...base, verdict: 'failed', error: error.stack }
      process.exitCode = 1
    }
    await json(directory + '/verdict.json', verdict)
  }
  console.log(JSON.stringify(verdict))
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await browser(JSON.parse(await fs.readFile(process.argv[2], 'utf8')), process.argv[3])

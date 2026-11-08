import { approve, changed, deny } from './approval.mjs'
import { outcome } from './outcome.mjs'
import { question } from './question.mjs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as assert from 'node:assert/strict'
import { command, json, identity, alive } from './process.mjs'
import { stopCaptured } from './recovery.mjs'
import { control } from './socket.mjs'
import { rpc, settled, history, chat, conversation } from './wire.mjs'
import { features, stop, png, program, ranProgram } from './drive.mjs'
import { watchBrowser } from './watchbrowser.mjs'
import { procedureBrowser } from './procedurebrowser.mjs'
import { deviceBrowser } from './devicebrowser.mjs'
import { readBrowser } from './readbrowser.mjs'
import { settingsBrowser } from './settingsbrowser.mjs'
import { learningBrowser, memoryBrowser } from './memorybrowser.mjs'
import { nameBrowser } from './namebrowser.mjs'
import { feedBrowser } from './feedbrowser.mjs'
import { owedBrowser } from './owedbrowser.mjs'
import { todosBrowser } from './todosbrowser.mjs'
import { projectsBrowser } from './projectsbrowser.mjs'
import { offerBrowser } from './offer.mjs'
import { libraryBrowser } from './librarybrowser.mjs'
import { pushBrowser } from './push.mjs'
import { computerBrowser, integrationsBrowser } from './accessbrowser.mjs'

const web = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { createElement } = web('react')
const { renderToStaticMarkup } = web('react-dom/server')
const Markdown = web('react-markdown').default
const gfm = web('remark-gfm').default

/** Use the web's Markdown parser so formatting and link destinations are not reply text. */
function renderedReply(text) {
  const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [gfm] }, text))
  return `(() => {
    const body = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html').body
    for (const block of body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,br,tr,td,th')) {
      block.prepend(' ')
      block.append(' ')
    }
    return (${normaliseReply.toString()})(body.textContent)
  })()`
}

/** Ignore whitespace and terminal punctuation while preserving exact reply content. */
function normaliseReply(text) {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\p{P}\s]+$/gu, '')
    .trim()
}

const missing = {
  handoff: 'No proof-owned Computer',
  discord: 'No browser recipe for the Discord Key form and Allow card yet',
  github: 'No browser recipe for the GitHub Key form yet',
  'texting-discord': 'No browser recipe for Text Vivid Discord connect yet',
}
const recipes = {
  code: { check: 'code' },
  approve: { check: 'approve' },
  deny: { check: 'deny' },
  outcome: { check: 'outcome' },
  changed: { check: 'changed' },
  question: { check: 'question' },
  stop: { check: 'stop' },
  reading: { check: 'reading' },
  settings: { check: 'settings' },
  name: { check: 'name' },
  memory: { check: 'memory' },
  learning: { check: 'learning' },
  push: { check: 'push' },
  procedure: { check: 'procedure' },
  devices: { check: 'devices' },
  watch: { check: 'watch' },
  feed: { check: 'feed' },
  owed: { check: 'owed' },
  todos: { check: 'todos' },
  projects: { check: 'projects' },
  replies: { check: 'replies' },
  library: { check: 'library' },
  integrations: { check: 'integrations' },
  capabilities: { check: 'capabilities' },
  computer: { check: 'computer' },
  first: {
    phrase:
      'Write a detailed 1000-word guide to planning a community garden. Write directly in this reply as plain paragraphs. Do not create a document or ask questions.',
    check: 'reply',
  },
  picture: { phrase: 'Hello Vivid with a picture. Acknowledge briefly.', check: 'picture' },
  reload: {
    phrase: 'What verification marker did I ask you to remember? Reply with the marker only.',
    check: 'reload',
  },
  tool: {
    phrase:
      'Show a rich interactive table using an openui-lang Table, not Markdown. Columns Project, Hours, Owner. Rows Research | 4 | Ada, Writing | 3 | Ben, Review | 2 | Cai. Title Workload.',
    rehearsal: 'show a table',
    check: 'table',
  },
  document: {
    phrase:
      'Write me a document called Verification plan that says: # Verification plan\nResearch, writing and review.',
    rehearsal: 'write a document',
    check: 'document',
  },
}
const specialRecipes = {
  learning: {
    drive: learningBrowser,
    scope:
      'Composer fact, native learner completion, one surviving memory entry and new-Thread recall through the web.',
  },
  library: {
    drive: libraryBrowser,
    scope:
      'File-picker upload, worker readiness, original-file tab, search, real model citation and reload',
  },
  code: {
    drive: codeBrowser,
    scope:
      "Composer Send, one run_code program on the synthetic Person's new Boat Computer, its file read back through Boat, the reply bubble before and after reload",
  },
  approve: {
    drive: approve,
    scope: 'Real Verify Pulse approval card, Allow, one provider event and reload',
  },
  deny: {
    drive: deny,
    scope: 'Real Verify Pulse approval card, denial, no provider event and reload',
  },
  outcome: {
    drive: outcome,
    scope:
      'Real Verify Pulse write allowed by rule, journaled Completed receipt, read-only reconciliation, and Delivered after the open Thread screen drew the reply',
  },
  changed: {
    drive: changed,
    scope:
      'Real Verify Pulse ask over a document, Person revision, stale card, fresh ask, Allow and reload',
  },
  question: {
    drive: question,
    scope: 'Real model question card, actual choice, Decision Run continuation and reload',
  },
  stop: {
    drive: stopBrowser,
    scope:
      'Actual Stop control during a real streamed reply, Stopped Run and interrupted reply after reload',
  },
  procedure: {
    drive: procedureBrowser,
    scope:
      'A walkthrough with a correction taught through the composer, learned once without being done, and applied in a second Thread after reload; see scope.json.',
  },
  watch: {
    drive: watchBrowser,
    scope:
      'browser Connect, model Watch, real Executor delivery of an event past 4,000 characters, the posted notice shown by the worker and routed to the Feed (the press itself is not driven), Feed reload, the event shown whole in its Thread after reload, and Disconnect',
  },
  replies: {
    drive: offerBrowser,
    scope:
      "Suggested replies drawn under the newest reply, unchanged after reload, and a tap sent as the Person's next message; the phone draws them separately.",
  },
  devices: {
    drive: deviceBrowser,
    scope:
      'Device permission controls only; see scope.json. No model, Feed delivery or Watch generation claim.',
  },
  todos: {
    drive: todosBrowser,
    scope:
      'To-dos added and ticked off from the composer, shown on the web Feed, a row ticked off by its check and absent after reload; see scope.json.',
  },
  owed: {
    drive: owedBrowser,
    scope:
      'Waiting-on row tracked from the composer, shown on the web Feed, resolved by its check and absent after reload; see scope.json.',
  },
  projects: {
    drive: projectsBrowser,
    scope:
      'Project objective and dated progress recorded from the composer, shown on the web Project page under Where it stands and unchanged after reload; see scope.json.',
  },
  feed: {
    drive: feedBrowser,
    scope:
      'Ordinary Conversation Feed only; see scope.json. Watch delivery and native controls remain unproved.',
  },
  reading: {
    drive: readBrowser,
    scope:
      'One web session, 52 Threads, repeat suppression, eviction after 50 remembered standings, unchanged standing after rename, real offscreen reply and one read on return. See scope.json for blocked subcases.',
  },
  name: {
    drive: nameBrowser,
    scope:
      'Web Settings name form, the name after reload, and Vivid answering with it in a Thread. See scope.json for phone and shared-Thread subcases.',
  },
  push: {
    drive: pushBrowser,
    scope:
      'Settings row on and off, the server holding this browser once, and a real notify_person reaching the service worker; see scope.json.',
  },
  integrations: {
    drive: integrationsBrowser,
    scope:
      'Verify Pulse key typed in its Settings card, its access panel saying the server grant, and a real model read whose partial coverage is said under the reply, each before and after reload; see scope.json.',
  },
  computer: {
    drive: computerBrowser,
    scope:
      'Settings Vivid’s computer panel: server health title, recovery ladder shown and never offered, after Check again and reload, without waking a Computer; see scope.json.',
  },
  capabilities: {
    drive: computerBrowser,
    scope:
      'What Vivid can do on its Computer is drawn in the same panel from its health; for this run’s absent Computer that is the panel’s title and ladder only. See scope.json.',
  },
  settings: {
    drive: settingsBrowser,
    scope:
      'Personal Settings groups, current memory index rendered before and after reload, popular Integration groups and Gmail search. See scope.json for unproved groups and native entry points.',
  },
}
for (const name of features)
  assert.ok(recipes[name] || missing[name], 'Unmapped browser feature ' + name)

/** The program is asked through the composer; since 26 October 2026 a Thread draws no step
 * rows, so the browser proves the reply bubble and the HTTP history proves the receipt. */
async function codeBrowser(state, id, directory, client) {
  const asked = program(state)
  await client.capture('before')
  await client.run(['find', 'label', 'Message Vivid', 'fill', asked.phrase])
  await client.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory)
  await ranProgram(state, page, asked, directory)
  for (const stage of ['after', 'reloaded']) {
    if (stage === 'reloaded') await client.run(['reload'])
    await client.run([
      'wait',
      '--fn',
      `document.querySelectorAll('[data-vivid-bubble]').length > 0`,
    ])
    await client.capture(stage)
  }
  const reloaded = await history(state, id, directory, 'reloaded-history')
  assert.deepEqual(reloaded.messages, page.messages)
}

/** Read semantic DOM through the owned browser, with the serialized result retained as evidence. */
async function dom(run, expression) {
  const value = JSON.parse(await run(['eval', 'JSON.stringify(' + expression + ')']))
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Copy sits in either a plain footer or the combined work footer (Message.tsx). Scope to its
 * assistant row so footer depth cannot hide Markdown; count messages, not matching descendants. */
function replyCount(text) {
  return `Array.from(document.querySelectorAll('button[aria-label="Copy message"]')).filter(button => Array.from(button.closest('li').querySelectorAll('div')).some(element => !element.contains(button) && (${normaliseReply.toString()})(element.innerText) === ${JSON.stringify(text)})).length`
}

/** The same presence assertion must reject the pre-follow-up DOM and pass after rendering. */
function requireReply(count) {
  assert.equal(count, 1, 'Expected exactly one assistant message with the exact reply')
}

/** The shared Stop proof uses the actual composer control. Exact rendered text waits for the
 * web's reveal to finish before reload, so animation timing cannot truncate the comparison. */
async function stopBrowser(state, id, directory, client) {
  const page = await stop(state, id, directory, client)
  const text = page.messages
    .filter((message) => message.purpose === 'assistant')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
  for (const stage of ['stopped', 'reloaded']) {
    if (stage === 'reloaded') await client.run(['reload'])
    await client.run(['wait', '[aria-label="Message Vivid"]'])
    await exactReply(client.run, text, directory, stage)
    assert.equal(
      await dom(client.run, `Boolean(document.querySelector('button[aria-label="Stop"]'))`),
      false,
    )
    await client.capture(stage)
  }
  const reopened = await history(state, id, directory, 'browser-reloaded-history')
  assert.equal(reopened.working, false, 'Browser reload restarted the conversation')
  assert.equal(reopened.queued, 0)
  assert.deepEqual(reopened.settlements, page.settlements)
  assert.deepEqual(
    reopened.messages.map((message) => ({ id: message.id, parts: message.parts })),
    page.messages.map((message) => ({ id: message.id, parts: message.parts })),
  )
  const detail = await rpc(state, 'GetThread', { id }, directory, 'browser-reloaded-thread')
  assert.equal(detail.runs.length, 1, 'Browser reload created another Run')
  assert.equal(detail.runs[0].state._tag, 'Stopped')
  assert.equal(detail.runs[0].submissionId, page.settlements[0].submissionId)
}

/** Retain counts at each DOM boundary so HTTP history cannot substitute for visible replies. */
async function exactReply(run, text, directory, stage) {
  const normalised = await dom(run, renderedReply(text))
  assert.ok(normalised.length > 0, 'Assistant reply is empty after normalisation')
  const expression = replyCount(normalised)
  if (stage !== 'before') await run(['wait', '--fn', expression + ' === 1'])
  const count = await dom(run, expression)
  const receipt = { stage, text, normalised, count, expression }
  await json(directory + '/' + stage + '-reply.json', receipt)
  if (stage === 'before') {
    assert.equal(count, 0, 'Follow-up reply already present before sending')
  } else requireReply(count)
}

/** The checks use rendered semantic elements. Raw source or assistant prose cannot satisfy them. */
async function rendered(run, kind) {
  switch (kind) {
    case 'table': {
      await run([
        'wait',
        '--fn',
        `Array.from(document.querySelectorAll('table')).some(t => ['Project','Hours','Owner'].every(h => Array.from(t.querySelectorAll('th')).some(c => c.textContent.trim() === h)) && [['Research','4','Ada'],['Writing','3','Ben'],['Review','2','Cai']].every(expected => Array.from(t.querySelectorAll('tbody tr')).some(row => expected.every((value, i) => row.querySelectorAll('td')[i]?.textContent.trim() === value))))`,
      ])
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
      for (const row of [
        ['Research', '4', 'Ada'],
        ['Writing', '3', 'Ben'],
        ['Review', '2', 'Cai'],
      ])
        assert.ok(
          table.rows.some((actual) => row.every((cell, i) => actual[i] === cell)),
          'Missing table row ' + row.join(' / '),
        )
      break
    }
    case 'picture': {
      await run([
        'wait',
        '--fn',
        `Array.from(document.images).some(image => image.src.includes('/attachments/') && image.complete && image.naturalWidth > 0)`,
      ])
      await run([
        'eval',
        `JSON.stringify(Array.from(document.images).filter(image => image.src.includes('/attachments/')).map(image => ({ src: image.src, width: image.naturalWidth, height: image.naturalHeight })))`,
      ])
      break
    }
    case 'document': {
      // Since 26 October 2026 a Thread draws no step rows (the owner: "tool call spam ... the user
      // doesn't need to see this"): the reply is Vivid's bubbles, and the document's receipt is
      // proved by the HTTP recipe's versioning. The browser proves the reply arrived as a bubble
      // and that no step list or "Worked" line came back.
      await run(['wait', '--fn', `document.querySelectorAll('[data-vivid-bubble]').length > 0`])
      const leftovers = await dom(
        run,
        `Array.from(document.querySelectorAll('button[aria-expanded]')).map(b => b.textContent.trim()).filter(text => text.includes('more steps') || text.startsWith('Worked') || text.includes('Wrote a document'))`,
      )
      assert.deepEqual(leftovers, [], 'A step row is still drawn in the Thread')
      await run(['snapshot'])
      break
    }
    case 'reply':
    case 'reload':
      break
    default:
      throw new Error('Unknown rendered assertion ' + kind)
  }
}

/** Reload on admitted work. A provider may publish its text only in the terminal frame, so
 * waiting for a text chunk first can consume the entire reply and miss a valid reconnect. */
async function reloadStreaming(state, id, directory, run) {
  for await (const active of conversation(state, id, { directory, name: 'before-reload-stream' })) {
    assert.equal(active.settlements.length, 0, 'Reply settled before mid-stream reload')
    if (!active.working || !active.messages.some((message) => message.role === 'user')) continue
    await json(directory + '/midstream.json', active)
    await run(['reload'])
    return active
  }
  throw new Error('No streamed reply to reload')
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
    for (const tid of await fs.readdir(`/proc/${pid}/task`)) {
      const children = await fs
        .readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')
        .catch((error) => {
          if (error.code === 'ENOENT') return ''
          throw error
        })
      for (const child of children.trim().split(/\s+/).filter(Boolean)) {
        await capture(Number(child)).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
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
  assert.ok(
    processes.length > 0,
    'No private browser daemon PID receipt; ownership cannot be proved',
  )
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
    diffHash: state.diffHash,
    evidence: directory,
  }
  const reason =
    [
      'memory',
      'procedure',
      'question',
      'approve',
      'deny',
      'changed',
      'outcome',
      'owed',
      'todos',
      'name',
      'code',
      'projects',
    ].includes(feature) && state.modelKind !== 'real'
      ? feature + ' requires a real model.'
      : feature === 'code' && state.computer !== 'disposable'
        ? 'Needs a disposable Person Computer. Launch had no VIVID_BOAT_API_KEY.'
        : missing[feature]
  const stopBlocked = feature === 'stop' && state.modelKind !== 'real'
  if (reason || stopBlocked) {
    const verdict = {
      ...base,
      verdict: 'blocked',
      reason: stopBlocked
        ? 'Stop requires a real model; rehearsal cannot prove interruption.'
        : missing[feature]
          ? 'no browser recipe: ' + reason
          : reason,
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
        redactions: [account.password, 'verify-pulse-local'],
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
    let existing
    if (feature === 'reload') {
      await chat(
        state,
        id,
        'Remember the verification marker amber-orchid. Acknowledge briefly.',
        directory,
        'seed',
      )
      await settled(state, id, 1, 'Completed', directory)
      existing = await history(state, id, directory, 'existing-history')
    }
    await run(['open', state.web + '/t/' + id])
    await captureBrowser(receipt)
    await run([
      'wait',
      '--fn',
      `Boolean(document.querySelector('input[type=email]') || document.querySelector('[aria-label="Message Vivid"]'))`,
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
    if (feature in specialRecipes) {
      await specialRecipes[feature].drive(state, id, directory, {
        run,
        capture,
        exactReply: (text, stage) => exactReply(run, text, directory, stage),
      })
      verdict = {
        ...base,
        verdict: state.modelKind === 'rehearsal' ? 'plumbing-only' : 'proved',
        thread: id,
        scope: specialRecipes[feature].scope,
      }
    } else if (feature === 'memory') {
      await memoryBrowser(state, id, directory, {
        run,
        capture,
        render: (text) => dom(run, renderedReply(text)),
        normalise: normaliseReply,
      })
      verdict = {
        ...base,
        verdict: 'proved',
        thread: id,
        scope:
          'Memory tools through the web composer and reload; see scope.json. No owner lifecycle or server restart claim.',
      }
    } else {
      if (existing) {
        await run([
          'wait',
          '--text',
          'Remember the verification marker amber-orchid. Acknowledge briefly.',
        ])
        const reopened = await history(state, id, directory, 'reopened-history')
        assert.deepEqual(reopened.messages, existing.messages)
        await run(['reload'])
        await run([
          'wait',
          '--text',
          'Remember the verification marker amber-orchid. Acknowledge briefly.',
        ])
        await capture('existing-reloaded')
      }
      await capture('before')
      if (feature === 'reload') await exactReply(run, 'amber-orchid', directory, 'before')
      const recipe = recipes[feature]
      const phrase =
        state.modelKind === 'rehearsal' && recipe.rehearsal ? recipe.rehearsal : recipe.phrase
      await run(['find', 'label', 'Message Vivid', 'fill', phrase])
      if (feature === 'picture') {
        await fs.writeFile(directory + '/pixel.png', Buffer.from(png, 'base64'))
        await run(['upload', 'input[type=file]', directory + '/pixel.png'])
        await run(['wait', 'button[aria-label="Take off pixel.png"]'])
      }
      await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
      const interrupted =
        feature === 'first' ? await reloadStreaming(state, id, directory, run) : undefined
      await settled(state, id, feature === 'reload' ? 2 : 1, 'Completed', directory)
      const page = await history(state, id, directory)
      if (interrupted) {
        for (const message of interrupted.messages)
          assert.ok(
            page.messages.some((saved) => saved.id === message.id),
            'Reload lost a streamed entry',
          )
      }
      const replies = page.messages.filter((m) => m.role === 'assistant')
      assert.ok(
        replies.some((m) => m.parts.some((p) => p.type === 'text' && p.text.trim())),
        'No assistant reply',
      )
      const text = replies
        .at(-1)
        .parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim()
      if (feature === 'reload') assert.equal(await dom(run, renderedReply(text)), 'amber-orchid')
      if (recipe.check === 'reply' || recipe.check === 'reload')
        await exactReply(run, text, directory, 'after')
      await rendered(run, recipe.check)
      await capture('after')
      await run(['reload'])
      if (recipe.check === 'reply' || recipe.check === 'reload')
        await exactReply(run, text, directory, 'reloaded')
      await rendered(run, recipe.check)
      await capture('reloaded')
      const reloaded = await history(state, id, directory, 'reloaded-history')
      assert.equal(
        reloaded.messages.filter((m) => m.role === 'user').length,
        feature === 'reload' ? 2 : 1,
      )
      assert.deepEqual(reloaded.messages, page.messages)
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
            : feature === 'reload'
              ? 'reopen existing Thread, reload saved history, send contextual follow-up and reload both turns'
              : feature === 'first'
                ? 'reload during admitted model work, same entries, completed reply and reload'
                : 'composer send, rendered content and reload',
      }
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
      for (const owned of [...(receipt.processes ?? [])].reverse()) await stopCaptured(owned)
      for (const owned of receipt.processes ?? [])
        assert.equal(await alive(owned), false, 'Browser process survived close ' + owned.pid)
      await json(directory + '/browser-processes.json', receipt.processes ?? [])
      await fs.rm(receipt.socketDirectory, { recursive: true, force: true })
      await fs.unlink(state.scratch + '/browser.json')
    } catch (error) {
      verdict = { ...verdict, verdict: 'failed', cleanupError: error.stack }
      process.exitCode = 1
    }
    await json(directory + '/verdict.json', verdict)
  }
  console.log(JSON.stringify(verdict))
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await browser(JSON.parse(await fs.readFile(process.argv[2], 'utf8')), process.argv[3])

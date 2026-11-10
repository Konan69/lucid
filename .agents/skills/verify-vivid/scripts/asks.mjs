import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { connectPulse } from './watch.mjs'
import { providerSnapshot, restart } from './snapshot.mjs'
import { command } from './process.mjs'
import { chat, history, json, rpc, settled, until } from './wire.mjs'

/**
 * An Integration's own asks, through the real model, the disposable Executor and the web client:
 * the Verify Pulse operations that pause their call in Executor (`pulse.mjs`, `approve` and
 * `file`). The browser drives every state the Person sees; HTTP drives the same asks through the
 * public RPCs a client sends.
 *
 * 1. An Integration's Approval: the banner offers only Allow and Don't allow, its head is the
 *    tool's declared title with the account, the Feed card offers no draft, Allow sends once.
 * 2. An Integration's question after Allow: its form's defaults start filled in, an untouched
 *    required array is sent as `[]`, an untouched optional field is left out, a defaulted string
 *    is sent as given; Send answers it and the Thread shows the Person's "Sent".
 * 3. A composer message while a question waits: the composer says "Message Vivid", the question
 *    is withdrawn and its paused call is cancelled, so the Integration does not wait it out.
 * 4. An Approval and a question left unanswered run out at Executor's 15-minute deadline and the
 *    Thread says so in each one's own words.
 */

const SETTLE = 5 * 60 * 1000

/** One call of a Verify Pulse operation, asked in a Person's words. */
const prompt = (operation, title, receipt) =>
  `With my Verify Pulse Integration, call its ${operation} operation ("${title}") once for receipt ${receipt}. Find it with find_tools and call it with use_tool, input {"receipt": "${receipt}"}. Do not use emit or any other operation. Verify Pulse asks me itself before it acts, so call it now and do not ask me in words. Do not use run_code or create a Watch.`

/** What the form sends: its defaults, the required array untouched, and No for Urgent. */
const SENT = { priority: 'medium', summary: 'Phone form bug', labels: [], urgent: false }

/** Ask in the Thread, through the composer when a browser drives, else as the Person's RPC. */
async function say(state, id, words, directory, client, name) {
  if (client) {
    await client.run(['find', 'label', 'Message Vivid', 'fill', words])
    await client.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  } else await chat(state, id, words, directory, name)
}

/** Read the page through the owned browser; the serialized value is the evidence. */
async function read(client, expression) {
  const value = JSON.parse(await client.run(['eval', 'JSON.stringify(' + expression + ')']))
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** The texts of the buttons inside the open banner over the composer. */
const bannerRows = (label) =>
  `Array.from(document.querySelector('section[aria-label=${JSON.stringify(label)}]')?.querySelectorAll('button[data-choice] [data-asked="label"]') ?? []).map((row) => row.innerText.trim())`

/** Waits for the Thread's newest Integration Approval to be pending. */
const pendingApproval = (state, id, receipt, directory, name) =>
  until(
    state,
    id,
    (detail) =>
      detail.approvals.some(
        (approval) =>
          approval.action.continuation !== null &&
          approval.action.target.input?.receipt === receipt &&
          approval.state._tag === 'Pending',
      ),
    SETTLE,
    directory,
    name,
  ).then((detail) =>
    detail.approvals.find((approval) => approval.action.target.input?.receipt === receipt),
  )

/** Waits for the Integration's mid-call question raised after Allow on `receipt`'s call. */
const waitingQuestion = (state, id, receipt, directory, name) =>
  until(
    state,
    id,
    (detail) =>
      detail.requests.some(
        (request) =>
          request.integration?.target.input?.receipt === receipt &&
          request.state._tag === 'Waiting',
      ),
    SETTLE,
    directory,
    name,
  ).then((detail) =>
    detail.requests.find((request) => request.integration?.target.input?.receipt === receipt),
  )

/** Allow one Integration Approval: its banner's row in the browser, `DecideApproval` over HTTP. */
async function allow(state, approval, directory, client, stage) {
  if (client) {
    await client.run(['wait', 'section[aria-label="Vivid asks first"]'])
    await client.capture(stage)
    await client.run(['find', 'role', 'button', 'click', '--name', 'Allow', '--exact'])
  } else
    await rpc(
      state,
      'DecideApproval',
      { id: approval.id, digest: approval.digest, decision: { _tag: 'AllowOnce' } },
      directory,
      stage,
    )
}

/** The Feed's Needs you, with the Thread's ask on it, then back to the Thread. */
async function feed(state, id, client, words, stage) {
  // In-app, by the sidebar's Feed entry, as a Person gets there; no full page load.
  await client.run(['find', 'role', 'link', 'click', '--name', 'Feed', '--exact'])
  await client.run(['wait', '--text', words])
  await client.capture(stage)
  // The card is the element holding the ask's words with the most buttons, the smallest such:
  // never the page around it, which also holds the composer.
  const card = await read(
    client,
    `(() => { const found = Array.from(document.querySelectorAll('div, article, li, section')).filter((node) => node.innerText.includes(${JSON.stringify(words)}) && !node.querySelector('[aria-label="Message Vivid"]')).sort((a, b) => b.querySelectorAll('button').length - a.querySelectorAll('button').length || a.innerText.length - b.innerText.length)[0]; return found ? { buttons: Array.from(found.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean), fields: found.querySelectorAll('textarea, input').length } : null })()`,
  )
  await client.run(['back'])
  await client.run(['wait', '--fn', `location.pathname === ${JSON.stringify('/t/' + id)}`])
  await client.run(['wait', '[aria-label="Message Vivid"]'])
  return card
}

/** Step 1: an Integration's own Approval, decided Allow. */
async function approvalStep(state, id, directory, client) {
  const receipt = crypto.randomUUID()
  await say(
    state,
    id,
    prompt('approve', 'Send a verification pulse', receipt),
    directory,
    client,
    'approve',
  )
  const pending = await pendingApproval(state, id, receipt, directory, 'approval-pending')
  assert.match(pending.action.summary, /^Send .* with Verify Pulse$/u)
  if (client) {
    await client.run(['wait', 'section[aria-label="Vivid asks first"]'])
    assert.deepEqual(await read(client, bannerRows('Vivid asks first')), ['Allow', 'Don’t allow'])
    // The paused call waits on the Person: the Thread must not say it was never heard back about.
    assert.equal(
      await read(client, `document.body.innerText.includes('didn’t hear back')`),
      false,
      'A waiting Integration ask is not an unheard action',
    )
    const card = await feed(state, id, client, pending.action.summary, 'feed-approval')
    assert.ok(card, 'The Feed shows the Integration Approval')
    // The card's other button is its Thread's title, which opens the Thread.
    assert.deepEqual(
      card.buttons.filter((words) => /allow/iu.test(words)),
      ['Don’t allow', 'Allow'],
    )
    assert.equal(card.fields, 0, 'An Integration Approval is never offered as a draft')
  }
  await allow(state, pending, directory, client, 'approval')
  const done = await until(
    state,
    id,
    (detail) =>
      detail.approvals.some(
        (one) =>
          one.id === pending.id && one.state._tag !== 'Pending' && one.state._tag !== 'Executing',
      ),
    SETTLE,
    directory,
    'approval-done',
  )
  const ended = done.approvals.find((one) => one.id === pending.id)
  assert.equal(ended.state._tag, 'Succeeded')
  if (client) await client.capture('approval-done')
  return receipt
}

/** Step 2: Allow, then the mid-call form answered from its banner. */
async function questionStep(state, id, directory, client) {
  const receipt = crypto.randomUUID()
  await say(
    state,
    id,
    prompt('file', 'File a verification issue', receipt),
    directory,
    client,
    'file',
  )
  const pending = await pendingApproval(state, id, receipt, directory, 'file-pending')
  assert.match(pending.action.summary, /^File .* with Verify Pulse$/u)
  await allow(state, pending, directory, client, 'file-approval')
  const asked = await waitingQuestion(state, id, receipt, directory, 'question-waiting')
  assert.equal(asked.integration.continuation.pause._tag, 'Input')
  if (client) {
    await client.run(['wait', 'section[aria-label="Vivid\'s question"]'])
    await client.capture('question')
    const shown = await read(
      client,
      `(() => { const banner = document.querySelector('section[aria-label="Vivid\\'s question"]'); return { head: banner.querySelector('[data-asked="question"]').innerText.trim(), chosen: Array.from(banner.querySelectorAll('button[data-choice][aria-pressed="true"] [data-asked="label"], button[data-choice][aria-checked="true"] [data-asked="label"]')).map((b) => b.innerText.trim()), fields: Array.from(banner.querySelectorAll('input')).map((i) => ({ label: i.labels?.[0]?.innerText.trim(), value: i.value })), placeholder: document.querySelector('[aria-label="Message Vivid"]')?.getAttribute('placeholder') ?? null, send: banner.querySelector('button[type=submit]').disabled } })()`,
    )
    await json(directory + '/question-dom.json', shown)
    assert.equal(shown.head, 'Which priority should the issue have?')
    assert.deepEqual(shown.chosen, ['Medium'])
    assert.deepEqual(
      shown.fields.find((field) => field.label === 'Summary'),
      { label: 'Summary', value: 'Phone form bug' },
    )
    assert.equal(shown.send, true, 'Send waits for the required Urgent')
    // Needs you says a question waits and opens its Thread; it is answered only there.
    const card = await feed(state, id, client, 'Vivid has a question for you', 'feed-question')
    assert.ok(card === null || card.fields === 0, 'A question is answered only in its Thread')
    await client.run(['wait', 'section[aria-label="Vivid\'s question"]'])
    await client.run(['find', 'role', 'button', 'click', '--name', 'No', '--exact'])
    await client.capture('question-filled')
    await client.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  } else
    await rpc(
      state,
      'AnswerIntegrationInput',
      {
        id: asked.id,
        response: {
          action: 'accept',
          content: SENT,
        },
      },
      directory,
      'answer',
    )
  const answered = await until(
    state,
    id,
    (detail) => detail.requests.some((one) => one.id === asked.id && one.state._tag === 'Answered'),
    SETTLE,
    directory,
    'question-answered',
  )
  const request = answered.requests.find((one) => one.id === asked.id)
  assert.equal(request.integrationOutcome?._tag, 'Completed')
  // The operation returns what Executor's `ctx.elicit` received, which is what the form sent.
  assert.deepEqual(request.integrationOutcome.value, { action: 'accept', content: SENT })
  if (client) {
    await client.run(['wait', '--text', 'Sent'])
    await client.capture('question-sent')
  }
}

/** Step 3: a message while the question waits withdraws it and cancels its paused call. */
async function withdrawn(state, id, directory, client) {
  const receipt = crypto.randomUUID()
  await say(
    state,
    id,
    prompt('file', 'File a verification issue', receipt),
    directory,
    client,
    'withdraw',
  )
  const pending = await pendingApproval(state, id, receipt, directory, 'withdraw-pending')
  await allow(state, pending, directory, client, 'withdraw-approval')
  const asked = await waitingQuestion(state, id, receipt, directory, 'withdraw-waiting')
  if (client) {
    await client.run(['wait', 'section[aria-label="Vivid\'s question"]'])
    assert.equal(
      await read(
        client,
        `document.querySelector('[aria-label="Message Vivid"]').getAttribute('placeholder')`,
      ),
      'Message Vivid',
    )
  }
  await say(state, id, 'Never mind that issue for now.', directory, client, 'withdraw-message')
  const done = await until(
    state,
    id,
    (detail) =>
      detail.requests.some(
        (one) =>
          one.id === asked.id &&
          one.state._tag === 'Withdrawn' &&
          one.integrationOutcome?._tag === 'Cancelled',
      ),
    SETTLE,
    directory,
    'withdraw-cancelled',
  )
  assert.ok(done)
  if (client) await client.capture('withdrawn')
  return receipt
}

/** Step 4: an Approval and a question nobody answers run out at Executor's deadline. */
async function expired(state, id, directory, client) {
  const later = crypto.randomUUID()
  await say(
    state,
    id,
    prompt('file', 'File a verification issue', later),
    directory,
    client,
    'later',
  )
  const filed = await pendingApproval(state, id, later, directory, 'later-pending')
  const left = crypto.randomUUID()
  await say(
    state,
    id,
    prompt('approve', 'Send a verification pulse', left),
    directory,
    client,
    'left',
  )
  const unanswered = await pendingApproval(state, id, left, directory, 'left-pending')
  // Allowed over RPC: the banner holds the oldest Approval, and this one must leave `left` up.
  await allow(state, filed, directory, undefined, 'later-approval')
  const asked = await waitingQuestion(state, id, later, directory, 'later-waiting')
  // A restart drops both paused calls in Executor, as #227's live proof does, so the answers
  // that follow reach it too late: the server says Expired at once instead of in 15 minutes.
  await restartExecutor(state)
  await allow(state, unanswered, directory, client, 'left-approval')
  // The form's own Send is proved in step 2; this late answer only has to reach Executor.
  await rpc(
    state,
    'AnswerIntegrationInput',
    { id: asked.id, response: { action: 'accept', content: SENT } },
    directory,
    'late-answer',
  )
  const ran = await until(
    state,
    id,
    (detail) =>
      detail.approvals.some(
        (one) => one.id === unanswered.id && one.integrationOutcome?._tag === 'Expired',
      ) &&
      detail.requests.some(
        (one) => one.id === asked.id && one.integrationOutcome?._tag === 'Expired',
      ),
    SETTLE,
    directory,
    'expired',
  )
  assert.ok(ran)
  if (client) {
    await client.run(['reload'])
    await client.run(['wait', '--text', 'Expired before you answered. Nothing was sent.'])
    await client.run([
      'wait',
      '--text',
      'Expired before you answered. Verify Pulse may already have acted.',
    ])
    await client.capture('expired')
  }
  return left
}

/** Stop this run's own Executor container and start it again, awaiting its health. */
async function restartExecutor(state) {
  const label = (
    await command([
      'docker',
      'inspect',
      '--format',
      '{{index .Config.Labels "vivid.verify"}}',
      state.executorContainer,
    ])
  ).trim()
  assert.equal(label, state.run, 'Executor restart ownership mismatch')
  await command(['docker', 'stop', '--timeout', '0', state.executorContainer])
  await restart(state)
}

/** The whole journey, as one Thread; one provider export at the end proves what was sent. */
async function asks(state, id, directory, client) {
  assert.equal(state.modelKind, 'real')
  const integration = await connectPulse(state, directory)
  try {
    const allowed = await approvalStep(state, id, directory, client)
    await questionStep(state, id, directory, client)
    const cancelled = await withdrawn(state, id, directory, client)
    const left = await expired(state, id, directory, client)
    await settled(
      state,
      id,
      (await rpc(state, 'GetThread', { id }, directory)).runs.length,
      'Completed',
      directory,
    )
    await history(state, id, directory)
    if (client) {
      await client.run(['reload'])
      await client.run(['wait', '[aria-label="Message Vivid"]'])
      await client.capture('reloaded')
    }
    const provider = {}
    for (const [name, receipt, sent] of [
      ['allowed', allowed, 1],
      // Cancel reaches `ctx.elicit` as an answer, so the call ends and emits its one pulse.
      ['cancelled', cancelled, 1],
      ['expired', left, 0],
    ]) {
      const evidence = directory + '/provider-' + name
      await fs.mkdir(evidence, { recursive: true })
      provider[name] = await providerSnapshot(
        state,
        { callback: state.web + '/unused-asks-callback', receipt },
        evidence,
      )
      assert.equal(provider[name].events.length, sent, name + ' pulses')
    }
    await json(directory + '/proof.json', { provider })
  } finally {
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory)
  }
}

/** HTTP: the same asks through the Person's public RPCs. */
export const asksFeature = (state, id, directory) => asks(state, id, directory, undefined)

/** Browser: every state drawn, pressed and captured in the web client. */
export const asksBrowser = (state, id, directory, client) => asks(state, id, directory, client)

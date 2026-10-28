import * as NodeAssert from 'node:assert/strict'
import { history, json, rpc } from './wire.mjs'
import { observe } from './observation.mjs'
import { RunState } from '@vivid/contracts'

/** A ref is valid only in the current full snapshot. Preserve agent-device's snapshot pin. */
async function target(run, label, role) {
  await run(['wait', 'text', label, '60000'])
  const snapshot = await run(['snapshot', '-i', '--force-full'])
  const found = snapshot.split('\n').filter((line) => {
    const quoted = line.match(/"(?:\\.|[^"\\])*"/u)
    if (!quoted || !line.includes('[' + role + ']')) return false
    const name = quoted[0]
    const encoded = JSON.stringify(label)
    return (
      name === encoded ||
      name.startsWith(encoded.slice(0, -1) + ', ') ||
      name.startsWith(encoded.slice(0, -1) + ' ')
    )
  })
  NodeAssert.equal(found.length, 1, 'Expected one ' + role + ' named ' + label + '\n' + snapshot)
  return found[0].match(/@e\d+(?:~s\d+)?/u)[0]
}

/** Every phone recipe uses the real controls; public receipts establish identity and settlement. */
export function phoneUI(state, run, directory) {
  // Streaming intentionally keeps changing the tree. Do not ask Send/Stop to wait for UI quiet.
  const press = async (label, role = 'button') => {
    const ref = await target(run, label, role)
    if (label === 'Send' || label === 'Stop Vivid') return run(['press', ref])
    return run(['press', ref, '--settle'])
  }
  const fill = async (label, value, redactions = []) =>
    run(['fill', await target(run, label, 'text-field'), value, '--settle'], redactions)
  const visible = async (words) => run(['wait', 'text', words, '60000'])
  const capture = async (name) => {
    const snapshot = await run(['snapshot', '--force-full'])
    await json(directory + '/' + name + '.json', { snapshot })
    await run(['screenshot', directory + '/' + name + '.png'])
    return snapshot
  }
  const menu = async () => {
    const snapshot = await run(['snapshot', '-i', '--force-full'])
    if (!snapshot.includes('"Close menu"') && !snapshot.includes('"Open menu"'))
      await run(['back', '--settle'])
    if (!snapshot.includes('"Close menu"')) await press('Open menu')
  }
  const visit = async (id) => {
    const detail = await rpc(state, 'GetThread', { id }, directory, 'visit-' + id)
    await menu()
    const snapshot = await run(['snapshot', '-i', '--force-full'])
    if (snapshot.includes('"Stop searching"')) await press('Stop searching')
    await press('Search threads')
    await fill('Search threads', detail.thread.title)
    await press(detail.thread.title)
    await visible('Message Vivid')
    const opened = await run(['snapshot', '-i', '--force-full'])
    NodeAssert.ok(!opened.includes('"Close menu"'), 'Thread selection left the drawer open')
  }
  const create = async (title) => {
    const id = crypto.randomUUID()
    await rpc(state, 'CreateThread', { id, title, projectId: null }, directory, 'create-' + id)
    await visit(id)
    return id
  }
  const send = async (words) => {
    await fill('Message Vivid', words)
    await press('Send')
  }
  const completed = async (id, count, name) => {
    const detail = await observe(state, {
      tag: 'WatchThread',
      payload: { id },
      accept: (value) => {
        NodeAssert.ok(
          !value.runs.some((attempt) => RunState.guards.Failed(attempt.state)),
          'A phone Run failed',
        )
        return value.runs.length === count && RunState.guards.Completed(value.runs[count - 1].state)
      },
    })
    await json(directory + '/' + name + '-settlement.json', detail)
    const page = await history(state, id, directory, name)
    const completedRun = detail.runs[count - 1]
    const reply = textOf(
      page.messages.filter(
        (message) =>
          message.role === 'assistant' && message.submissionId === completedRun.submissionId,
      ),
    )
    NodeAssert.ok(reply.trim(), 'The settled phone Run has no assistant reply')
    return { detail, page, reply }
  }
  return { run, press, fill, visible, capture, menu, visit, create, send, completed, directory }
}

/** Text comparisons ignore tool parts; a tool result alone cannot prove a visible reply. */
export const textOf = (messages) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')

/** Surface a real streamed partial before an interruption or owner move, never a thinking flag. */
export async function streaming(state, id, directory) {
  const { conversation } = await import('./wire.mjs')
  for await (const page of conversation(state, id, { directory, name: 'active-stream' })) {
    NodeAssert.equal(page.settlements.length, 0, 'Reply settled before the phone action')
    const messages = page.messages.filter((message) => message.role === 'assistant')
    if (
      !page.working ||
      !messages.some((message) =>
        message.parts.some(
          (part) => part.type === 'text' && part.state === 'streaming' && part.text.trim(),
        ),
      )
    )
      continue
    const detail = await rpc(state, 'GetThread', { id }, directory, 'active-thread')
    NodeAssert.equal(detail.runs.length, 1)
    NodeAssert.equal(detail.runs[0].state._tag, 'Working')
    const partial = textOf(messages)
    await json(directory + '/active.json', { page, run: detail.runs[0], partial })
    return { page, run: detail.runs[0], partial }
  }
  throw new Error('No streamed phone reply')
}

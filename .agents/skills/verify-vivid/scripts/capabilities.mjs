import * as assert from 'node:assert/strict'
import { chat, history, json, rpc } from './wire.mjs'
import { command } from './process.mjs'
import { connectedOther } from './devices.mjs'

const blockedComputer = 'blocked: no proof-owned Computer (Boat trial plan at its two-machine limit; the only Vivid Computer is production’s)'

/** Only this run’s synthetic Person and container receive fixture rows. The finally block is
 * registered before insertion; no provider binding or machine is created or adopted. */
async function asleep(state, directory, action) {
  assert.match(state.person, /^[A-Za-z0-9_-]+$/u)
  const id = crypto.randomUUID()
  const sql = (statement) => command(['docker', 'exec', state.container, 'psql', '-U', 'verify', '-d', 'verify', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement])
  try {
    await sql(`INSERT INTO vivid_computers(id,person_id,machine,status,since,last_activity_at,created_at) VALUES ('${id}','${state.person}','verify-${id}','stopped',1,73,1);`)
    await action()
    const activity = await sql(`SELECT last_activity_at FROM vivid_computers WHERE id='${id}' AND person_id='${state.person}';`)
    assert.equal(activity.trim(), '73', 'Passive observations must not extend idle time')
    await json(directory + '/passive-activity.json', { lastActivityAt: 73 })
  } finally {
    await sql(`DELETE FROM vivid_computers WHERE id='${id}' AND person_id='${state.person}';`)
  }
}

/** Capability claims must be backed by a real registry receipt. */
async function answer(state, id, directory, name, question) {
  await chat(state, id, question, directory, name)
  const page = await history(state, id, directory, name + '-history')
  const parts = page.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.parts)
  const calls = parts.filter((part) => part.type === 'dynamic-tool' && part.toolName === 'get_capabilities' && part.state === 'output-available')
  assert.ok(calls.length > 0, 'The model must call get_capabilities')
  const latest = calls.at(-1)
  const reading = latest.output
  assert.ok(Array.isArray(reading.abilities), 'Capability receipt must include registry entries')
  const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  await json(directory + '/' + name + '-capabilities.json', { reading, text })
  return reading
}

/** Real model, public RPC and a real connected device stream exercise the runtime registry. */
export async function capabilities(state, id, directory) {
  assert.notEqual(state.modelKind, 'rehearsal', 'Capability answers require a real model')
  const absent = await rpc(state, 'GetCapabilities', null, directory, 'absent')
  assert.equal(absent.computer._tag, 'Available')
  assert.equal(absent.computer.value.state._tag, 'Absent')
  await answer(state, id, directory, 'no-computer', 'What can you do on my computer right now? Read your current capabilities before answering. Only describe what the current reading supports, and distinguish work that needs a connection. Do not perform any Computer work.')
  await asleep(state, directory, async () => {
    const sleeping = await rpc(state, 'GetCapabilities', null, directory, 'sleeping')
    assert.equal(sleeping.computer.value.state._tag, 'Stopped')
  })
  await connectedOther(state, directory, async () => {
    const reading = await answer(state, id, directory, 'connected-desktop', 'Check your current capabilities again. What can you do on my own computer now? Distinguish browser work from native apps. Do not perform any action on it.')
    assert.ok(reading.abilities.some((ability) => ability.tools.includes('use_person_computer') && ability.availability._tag === 'Unsupported'))
    assert.ok(reading.abilities.some((ability) => ability.tools.includes('browse') && ability.availability._tag === 'Available'))
  })
  await json(directory + '/limits.json', { deepHealth: blockedComputer, browserRestart: blockedComputer, semantics: 'Tool receipts and structured capability assertions; no semantic proof of every capability paraphrase.' })
}

/** Shallow lifecycle reads need no provider authority and must not create, wake or touch activity. */
export async function computer(state, _id, directory) {
  const absent = await rpc(state, 'GetComputerHealth', { depth: 'Shallow' }, directory, 'absent-health')
  assert.equal(absent._tag, 'Absent')
  await asleep(state, directory, async () => {
    const sleeping = await rpc(state, 'GetComputerHealth', { depth: 'Shallow' }, directory, 'sleeping-health')
    assert.equal(sleeping._tag, 'Sleeping')
    const request = { id: crypto.randomUUID(), step: 'Restore' }
    const first = await rpc(state, 'RecoverComputer', request, directory, 'unsupported-restore')
    assert.equal(first._tag, 'Unsupported')
    assert.deepEqual(await rpc(state, 'RecoverComputer', request, directory, 'same-restore'), first)
  })
  await json(directory + '/limits.json', { deepHealth: blockedComputer, browserRestart: blockedComputer })
}

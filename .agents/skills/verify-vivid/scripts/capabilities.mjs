import * as NodeAssert from 'node:assert/strict'
import { CapabilityAvailability, CapabilityReading, PersonId } from '@vivid/contracts'
import { Result, Schema } from 'effect'
import { chat, history, json, rpc } from './wire.mjs'
import { command } from './process.mjs'
import { connectedOther } from './devices.mjs'

const blockedComputer =
  'blocked: no proof-owned Computer (Boat trial plan at its two-machine limit; the only Vivid Computer is production’s)'
const decodePerson = Schema.decodeUnknownResult(PersonId)
const decodeReading = Schema.decodeUnknownResult(CapabilityReading)
const usable = CapabilityAvailability.isAnyOf(['Available', 'WakeOnUse'])

/** Only this run’s synthetic Person and container receive fixture rows. The finally block is
 * registered before insertion; no provider binding or machine is created or adopted. */
async function asleep(state, directory, action) {
  const person = Result.getOrThrow(decodePerson(state.person)).replaceAll("'", "''")
  const id = crypto.randomUUID()
  const sql = (statement) =>
    command([
      'docker',
      'exec',
      state.container,
      'psql',
      '-U',
      'verify',
      '-d',
      'verify',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      statement,
    ])
  try {
    await sql(
      `INSERT INTO vivid_computers(id,person_id,machine,status,since,last_activity_at,created_at) VALUES ('${id}','${person}','verify-${id}','stopped',1,73,1);`,
    )
    await action()
    const activity = await sql(
      `SELECT last_activity_at FROM vivid_computers WHERE id='${id}' AND person_id='${person}';`,
    )
    NodeAssert.equal(activity.trim(), '73', 'Passive observations must not extend idle time')
    await json(directory + '/passive-activity.json', { lastActivityAt: 73 })
  } finally {
    await sql(`DELETE FROM vivid_computers WHERE id='${id}' AND person_id='${person}';`)
  }
}

/** The answer must have a real capability receipt. Checking internal names against unavailable
 * entries supplements the structured facts; it does not claim semantic proof of every sentence. */
async function answer(state, id, directory, { name, question }) {
  await chat(state, id, question, directory, name)
  const page = await history(state, id, directory, name + '-history')
  const parts = page.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
  const calls = parts.filter(
    (part) =>
      part.type === 'dynamic-tool' &&
      part.toolName === 'get_capabilities' &&
      part.state === 'output-available',
  )
  NodeAssert.ok(calls.length > 0, 'The model must call get_capabilities')
  const latest = calls.at(-1)
  const reading = Result.getOrThrow(decodeReading(latest.output))
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  const unavailable = reading.abilities.filter((ability) => !usable(ability.availability))
  const availableTools = new Set(
    reading.abilities
      .filter((ability) => usable(ability.availability))
      .flatMap((ability) => ability.tools),
  )
  for (const toolName of unavailable.flatMap((ability) => ability.tools)) {
    if (availableTools.has(toolName)) continue
    // Plain verbs such as connect also occur in ordinary explanations. Only a snake-case
    // identifier, code span or call expression actually names a model tool.
    const identifier = toolName.includes('_')
      ? new RegExp('\\b' + toolName + '\\b', 'u')
      : new RegExp('`' + toolName + '`|\\b' + toolName + '\\s*\\(', 'u')
    NodeAssert.doesNotMatch(text, identifier, 'Answer names unavailable tool ' + toolName)
  }
  await json(directory + '/' + name + '-capabilities.json', { reading, text })
  return reading
}

/** Real model, public RPC and a real connected device stream exercise the runtime registry. */
export async function capabilities(state, id, directory) {
  NodeAssert.notEqual(state.modelKind, 'rehearsal', 'Capability answers require a real model')
  const absent = await rpc(state, 'GetCapabilities', null, directory, 'absent')
  NodeAssert.equal(absent.computer._tag, 'Available')
  NodeAssert.equal(absent.computer.value.state._tag, 'Absent')
  await answer(state, id, directory, {
    name: 'no-computer',
    question:
      'What can you do on my computer right now? Read your current capabilities before answering. Only describe what the current reading supports, and distinguish work that needs a connection. Do not perform any Computer work.',
  })
  await asleep(state, directory, async () => {
    const sleeping = await rpc(state, 'GetCapabilities', null, directory, 'sleeping')
    NodeAssert.equal(sleeping.computer.value.state._tag, 'Stopped')
  })
  await connectedOther(state, directory, async () => {
    const reading = await answer(state, id, directory, {
      name: 'connected-desktop',
      question:
        'Check your current capabilities again. What can you do on my own computer now? Distinguish browser work from native apps. Do not perform any action on it.',
    })
    NodeAssert.ok(
      reading.abilities.some(
        (ability) =>
          ability.tools.includes('use_person_computer') &&
          CapabilityAvailability.guards.Unsupported(ability.availability),
      ),
    )
    NodeAssert.ok(
      reading.abilities.some(
        (ability) =>
          ability.tools.includes('browse') &&
          CapabilityAvailability.guards.Available(ability.availability),
      ),
    )
  })
  await json(directory + '/limits.json', {
    deepHealth: blockedComputer,
    browserRestart: blockedComputer,
    semantics:
      'Tool receipts and unavailable internal-name checks; no claim that a keyword check judges every capability paraphrase.',
  })
}

/** Shallow lifecycle reads need no provider authority and must not create, wake or touch activity. */
export async function computer(state, _id, directory) {
  const absent = await rpc(
    state,
    'GetComputerHealth',
    { depth: 'Shallow' },
    directory,
    'absent-health',
  )
  NodeAssert.equal(absent._tag, 'Absent')
  await asleep(state, directory, async () => {
    const sleeping = await rpc(
      state,
      'GetComputerHealth',
      { depth: 'Shallow' },
      directory,
      'sleeping-health',
    )
    NodeAssert.equal(sleeping._tag, 'Sleeping')
    const request = { id: crypto.randomUUID(), step: 'Restore' }
    const first = await rpc(state, 'RecoverComputer', request, directory, 'unsupported-restore')
    NodeAssert.equal(first._tag, 'Unsupported')
    NodeAssert.deepEqual(
      await rpc(state, 'RecoverComputer', request, directory, 'same-restore'),
      first,
    )
  })
  await json(directory + '/limits.json', {
    deepHealth: blockedComputer,
    browserRestart: blockedComputer,
  })
}

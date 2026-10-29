import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeAssert from 'node:assert/strict'
import * as NodeUtil from 'node:util'
import { Schema } from 'effect'
import { rpc, chat, history, settled, json } from './wire.mjs'
import { connectWorld } from './watch.mjs'
import { executorRequest, ExecutorTools } from './executor.mjs'
import { privateJson } from './world.mjs'
import { score } from './scoring.mjs'
import { decodeText } from './receipts.mjs'

const BehaviourRun = Schema.Struct({
  run: Schema.String,
  head: Schema.String,
  tree: Schema.String,
  dirty: Schema.Boolean,
  model: Schema.String,
  modelKind: Schema.Literals(['real', 'rehearsal']),
  hostname: Schema.String,
  scratch: Schema.String,
  evidence: Schema.String,
  web: Schema.String,
  container: Schema.String,
  person: Schema.String,
})
const SentMail = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  from: Schema.String,
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  date: Schema.String,
  attachments: Schema.Array(Schema.String),
})
const CreatedEvent = Schema.Struct({
  id: Schema.String,
  calendar: Schema.String,
  title: Schema.String,
  start: Schema.String,
  end: Schema.String,
  attendees: Schema.Array(Schema.String),
  meet: Schema.Boolean,
})
const ReadRows = Schema.Array(Schema.Record(Schema.String, Schema.Json))
const ReadResult = {
  sent_messages: Schema.Struct({ messages: Schema.Array(SentMail) }),
  created_events: Schema.Struct({ events: Schema.Array(CreatedEvent) }),
  read_thread: Schema.Struct({ thread: Schema.Struct({ messages: ReadRows }) }),
  list_events: Schema.Struct({ events: ReadRows }),
}

const Scenarios = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
    connected: Schema.Array(Schema.Literals(['Mail', 'Calendar'])),
    words: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
    checks: Schema.Struct({
      replyIncludes: Schema.Array(Schema.String),
      replyExcludes: Schema.Array(Schema.String),
      mailSent: Schema.Number,
      calendarCreated: Schema.Number,
      choice: Schema.Boolean,
      connect: Schema.Boolean,
    }),
  }),
)

/** Fresh connections give each trial a fresh app database through ordinary public reclamation. */
async function reset(state) {
  const listed = await rpc(state, 'ListConnections')
  for (const connection of listed.connections)
    if (['mail', 'calendar'].includes(connection.service))
      await rpc(state, 'RemoveConnection', { id: connection.id })
}

/** Provider reads observe actual committed effects. They do not run through the model. */
async function appRead(state, integration, name, input) {
  const path = '/apps/' + encodeURIComponent(integration.app)
  const tools = await executorRequest(state, path + '/tools', { schema: ExecutorTools })
  NodeAssert.ok(
    tools.items.some((tool) => tool.name === name),
    'Missing world read ' + name,
  )
  const response = await executorRequest(state, path + '/tools/call', {
    schema: ReadResult[name],
    body: { version: tools.version, kind: 'query', tool: name, input },
  })
  return response
}

/** A later ordinary read must find each send in its thread, beyond the sent-message journal. */
async function effects(state, integrations, directory) {
  const mail = integrations.Mail
    ? (await appRead(state, integrations.Mail, 'sent_messages', {})).messages
    : []
  const calendar = integrations.Calendar
    ? (await appRead(state, integrations.Calendar, 'created_events', {})).events
    : []
  const readBack = []
  for (const message of mail) {
    const result = await appRead(state, integrations.Mail, 'read_thread', {
      threadId: message.threadId,
    })
    const stored = result.thread.messages.find((item) => item.id === message.id)
    readBack.push({
      id: message.id,
      pass: NodeUtil.isDeepStrictEqual(stored, message),
    })
  }
  for (const event of calendar) {
    const result = await appRead(state, integrations.Calendar, 'list_events', {
      start: event.start,
      end: event.end,
    })
    readBack.push({
      id: event.id,
      pass: result.events.some((item) => NodeUtil.isDeepStrictEqual(item, event)),
    })
  }
  await json(directory + '/effects.json', { mail, calendar, readBack })
  return { mail, calendar, readBack }
}

/** Every attempt owns a Thread. A failed attempt still retains its history and scored record. */
async function trial(state, scenario, number, directory) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 })
  const id = crypto.randomUUID()
  const turns = []
  let failure = null
  let integrations = {}
  try {
    await reset(state)
    integrations = await connectWorld(state, directory, scenario.connected)
    await rpc(
      state,
      'CreateThread',
      { id, title: 'Behaviour ' + scenario.id, projectId: null },
      directory,
    )
    for (const [index, words] of scenario.words.entries()) {
      const turnDirectory = directory + '/turn-' + (index + 1)
      await NodeFSP.mkdir(turnDirectory, { mode: 0o700 })
      const start = Date.now()
      const reply = await chat(state, id, words, turnDirectory)
      await settled(state, id, index + 1, 'Completed', turnDirectory)
      turns.push({
        turn: index + 1,
        characters: reply.length,
        seconds: (Date.now() - start) / 1000,
      })
    }
  } catch (error) {
    failure = error.message
  }
  let page = { messages: [] }
  try {
    page = await history(state, id, directory)
  } catch (error) {
    failure = failure || error.message
  }
  let observed = { mail: [], calendar: [], readBack: [] }
  try {
    observed = await effects(state, integrations, directory)
  } catch (error) {
    failure = failure || error.message
  }
  const metrics = score(page, turns, observed, scenario.checks)
  const result = Object.assign(
    { scenario: scenario.id, trial: number, thread: id, failure },
    metrics,
  )
  result.pass =
    !failure &&
    metrics.pass &&
    ['provenance', 'display', 'wiring', 'tools', 'effects', 'connect'].every(
      (key) => metrics[key].pass,
    )
  await json(directory + '/trial.json', result)
  return result
}

/** A rate always includes failed attempts in its denominator. No favourable trial is selected. */
function summary(results) {
  const names = [...new Set(results.map((result) => result.scenario))]
  return names.map((scenario) => {
    const attempts = results.filter((result) => result.scenario === scenario)
    return {
      scenario,
      trials: attempts.length,
      ...Object.fromEntries(
        ['provenance', 'display', 'wiring', 'tools', 'effects', 'connect'].map((metric) => [
          metric,
          attempts.filter((result) => !result.failure && result[metric].pass).length /
            attempts.length,
        ]),
      ),
      expected:
        attempts.filter((result) => !result.failure && result.expected.every((check) => check.pass))
          .length / attempts.length,
      passed: attempts.filter((result) => result.pass).length / attempts.length,
    }
  })
}

/** Only private scenario content enters chat. Console summaries contain ids and numeric rates. */
export async function behaviour(state, args) {
  NodeAssert.equal(state.modelKind, 'real', 'Behaviour needs a real model, never rehearsal')
  const world = process.env.VIVID_VERIFY_WORLD
  NodeAssert.ok(world, 'Set VIVID_VERIFY_WORLD to the private world directory')
  let trials = 1
  let path = NodePath.resolve(world, 'scenarios.json')
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--trials') trials = Number(args[index + 1])
    else if (args[index] === '--scenarios') path = NodePath.resolve(args[index + 1])
    else throw new Error('Unknown behaviour option ' + args[index])
  }
  NodeAssert.ok(Number.isInteger(trials) && trials > 0, 'Trials must be a positive integer')
  const scenarios = await privateJson(NodePath.dirname(path), NodePath.basename(path), Scenarios)
  NodeAssert.equal(
    new Set(scenarios.map((scenario) => scenario.id)).size,
    scenarios.length,
    'Duplicate scenario ids',
  )
  const directory = state.evidence + '/behaviour'
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 })
  await NodeAssert.rejects(
    NodeFSP.access(directory + '/run.json'),
    'Choose a fresh run for another suite',
  )
  const results = []
  for (const scenario of scenarios)
    for (let number = 1; number <= trials; number++) {
      const result = await trial(
        state,
        scenario,
        number,
        directory + '/' + scenario.id + '/' + number,
      )
      results.push(result)
      console.log(
        JSON.stringify({
          scenario: scenario.id,
          trial: number,
          pass: result.pass,
          failed: result.failure !== null,
        }),
      )
    }
  const rates = summary(results)
  const run = {
    run: state.run,
    head: state.head,
    tree: state.tree,
    dirty: state.dirty,
    model: state.model,
    modelKind: state.modelKind,
    host: state.hostname,
    feature: '.agents/skills/verify-vivid/features/behaviour.md',
    trials,
    results,
    summary: rates,
    evidence: directory,
  }
  await json(directory + '/run.json', run)
  const fields = [
    'scenario',
    'trials',
    'provenance',
    'display',
    'wiring',
    'tools',
    'effects',
    'connect',
    'expected',
    'passed',
  ]
  const table =
    [
      fields.join(' | '),
      fields.map(() => '---').join(' | '),
      ...rates.map((row) => fields.map((key) => row[key]).join(' | ')),
    ].join('\n') + '\n'
  await NodeFSP.writeFile(directory + '/summary.md', table, { mode: 0o600 })
  console.log(table)
  // Behaviour failures are the measured result, not a failure to run the suite.
  if (results.some((result) => result.failure !== null)) process.exitCode = 1
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  await behaviour(
    decodeText(BehaviourRun, await NodeFSP.readFile(process.argv[2], 'utf8')),
    process.argv.slice(3),
  )

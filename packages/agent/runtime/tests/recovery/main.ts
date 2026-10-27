import type * as NodeChildProcess from 'node:child_process'
import NodeProcess from 'node:process'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { BuiltinSkills } from '../../src/skills.ts'
import { NodeRuntime } from '@effect/platform-node'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { Effect, Layer, Queue, Schema } from 'effect'
import { held, start } from '../process.ts'

/** This executable requires the private channel its owning test opened. */
const send = (message: NodeChildProcess.Serializable) => {
  if (NodeProcess.send === undefined) throw new Error('The fixture needs IPC')
  NodeProcess.send(message)
}

const Request = Schema.Struct({
  id: Schema.Int,
  path: Schema.String,
  method: Schema.Literals(['GET', 'POST']),
  body: Schema.optionalKey(Schema.Json),
})
const decodeRequest = Schema.decodeUnknownEffect(Request)
const settings = Schema.decodeUnknownEffect(
  Schema.Struct({
    VIVID_TEST_DATABASE_URL: Schema.String,
    VIVID_TEST_NOTES: Schema.String,
    VIVID_TEST_MODE: Schema.Literals(['interrupt', 'resume', 'tool', 'failure']),
  }),
)

/** IPC is only the fixture's request transport; every operation enters the production HTTP routes.
 * A replay-safe tool kills its own process after Pi committed its running task. */
const main = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* settings(NodeProcess.env)
    const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'text' }], tokensPerSecond: 0 })
    const blocked = yield* held(
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid api key' }),
    )
    faux.setResponses([
      (context, options, state, model) => {
        send('model')
        if (config.VIVID_TEST_MODE === 'interrupt' || config.VIVID_TEST_MODE === 'failure')
          return blocked.factory(context, options, state, model)
        if (config.VIVID_TEST_MODE === 'tool')
          return fauxAssistantMessage(fauxToolCall('activate_skill', {}), { stopReason: 'toolUse' })
        return fauxAssistantMessage('continued')
      },
      fauxAssistantMessage('next answered'),
    ])
    const skills = Layer.succeed(
      BuiltinSkills,
      defineExtension({
        name: 'crashing-tool',
        tools: [
          defineTool({
            name: 'activate_skill',
            description: 'Crash this fixture process before making progress.',
            parameters: Type.Object({}),
            replay: 'safe',
            execute: () => {
              NodeProcess.kill(NodeProcess.pid, 'SIGKILL')
              return Promise.resolve({})
            },
          }),
        ],
      }),
    )
    const runtime = yield* start(
      { database: config.VIVID_TEST_DATABASE_URL, notes: config.VIVID_TEST_NOTES, faux, asked: [] },
      { idleMillis: 60_000 },
      skills,
    )
    const messages = yield* Queue.unbounded<NodeChildProcess.Serializable>()
    const listener = (message: NodeChildProcess.Serializable) =>
      Queue.offerUnsafe(messages, message)
    yield* Effect.acquireRelease(
      Effect.sync(() => NodeProcess.on('message', listener)),
      () => Effect.sync(() => NodeProcess.off('message', listener)),
    )
    const background = yield* Effect.scope
    /** Each request runs separately so a settlement wait cannot block admission or release. */
    const handle = Effect.fn('RecoveryFixture.request')(function* (
      message: NodeChildProcess.Serializable,
    ) {
      if (message === 'release') return yield* blocked.release
      const request = yield* decodeRequest(message)
      const response = yield* runtime.send(request.path, request)
      return yield* Effect.sync(() => send({ id: request.id, ...response }))
    })
    yield* Queue.take(messages).pipe(
      Effect.flatMap((message) => Effect.forkIn(handle(message), background)),
      Effect.forever,
      Effect.forkScoped,
    )
    send('ready')
    return yield* Effect.never
  }),
)

NodeRuntime.runMain(main)

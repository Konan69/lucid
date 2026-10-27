import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { describe, expect, it } from '@effect/vitest'
import {
  ConversationState,
  RuntimeAdmissionReceipt,
  RuntimeSettlement,
  type RuntimeSubmissionId,
} from '@vivid/contracts'
import { Deferred, Effect, Option, Schema } from 'effect'
import { databaseConfigured } from '../tests/database.ts'
import { world, type World } from '../tests/process.ts'
import { ada, delivery, threadPath } from '../tests/requests.ts'

const packageRoot = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const response = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.Int, status: Schema.Int, body: Schema.Json }),
)
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Int, body: Schema.Json }),
)
const receipt = Schema.decodeUnknownEffect(RuntimeAdmissionReceipt)
const settlement = Schema.decodeUnknownEffect(RuntimeSettlement)
const state = Schema.decodeUnknownEffect(ConversationState)
const thread = threadPath(ada, 'thread-recovery')

/** A real OS process on this case's database. IPC carries HTTP requests and readiness receipts.
 * Every child is stopped by its captured handle, even when an assertion fails. */
const processOn = Effect.fn('RecoveryTest.process')(function* (
  given: World,
  mode: 'interrupt' | 'resume' | 'tool' | 'failure',
) {
  const ready = yield* Deferred.make<void>()
  const model = yield* Deferred.make<void>()
  const replies = new NodeEvents.EventEmitter()
  const output: string[] = []
  const child = NodeChildProcess.fork(NodePath.join(packageRoot, 'tests/recovery/main.ts'), [], {
    cwd: packageRoot,
    execArgv: ['--import', 'tsx'],
    env: {
      PATH: process.env.PATH,
      VIVID_TEST_DATABASE_URL: given.database,
      VIVID_TEST_NOTES: given.notes,
      VIVID_TEST_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const exit = NodeEvents.EventEmitter.once(child, 'exit')
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      return exit.then(() => {})
    }),
  )
  if (child.stdout === null || child.stderr === null)
    return yield* Effect.die(new Error('The fixture needs piped output'))
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  child.on('message', (message) => {
    if (message === 'ready') Deferred.doneUnsafe(ready, Effect.void)
    else if (message === 'model') Deferred.doneUnsafe(model, Effect.void)
    else {
      const decoded = response(message)
      if (Option.isSome(decoded)) replies.emit(String(decoded.value.id), decoded.value)
    }
  })
  let next = 0
  const request = (path: string, body?: ReturnType<typeof delivery>) =>
    Effect.promise(() => {
      const id = ++next
      const answered = NodeEvents.EventEmitter.once(replies, String(id)).then(([value]) => value)
      const command =
        body === undefined ? { id, path, method: 'GET' } : { id, path, method: 'POST', body }
      child.send(command)
      return Promise.race([
        answered.then(decodeAnswer),
        exit.then(() => {
          throw new Error(`Runtime exited before responding. ${output.join('')}`)
        }),
      ])
    })
  return {
    ready: Effect.raceFirst(
      Deferred.await(ready),
      Effect.promise(() =>
        exit.then(() => {
          throw new Error(output.join(''))
        }),
      ),
    ),
    model: Deferred.await(model),
    exit: Effect.promise(() => exit),
    kill: Effect.sync(() => child.kill('SIGKILL')),
    release: Effect.sync(() => child.send('release')),
    output: () => output.join(''),
    request,
    admit: (key: string, body: string) =>
      request(thread, delivery('thread-recovery', key, { body })).pipe(
        Effect.tap((answer) => Effect.sync(() => expect(answer.status).toBe(202))),
        Effect.flatMap((answer) => receipt(answer.body)),
      ),
    settled: (id: RuntimeSubmissionId) =>
      request(`${thread}/submissions/${id}?wait=1`).pipe(
        Effect.tap((answer) => Effect.sync(() => expect(answer.status).toBe(200))),
        Effect.flatMap((answer) => settlement(answer.body)),
      ),
  }
})

describe.skipIf(!databaseConfigured)('replies across process failures', () => {
  it.live(
    'continues an interrupted reply after SIGKILL without another input',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const given = yield* world()
          const before = yield* processOn(given, 'interrupt')
          yield* before.ready
          const input = yield* before.admit('interrupted', 'one')
          yield* before.model
          yield* before.kill
          expect(yield* before.exit).toEqual([null, 'SIGKILL'])
          const after = yield* processOn(given, 'resume')
          yield* after.ready
          expect(yield* after.settled(input.submissionId)).toEqual(
            RuntimeSettlement.cases.Done.make({
              answeredBy: input.submissionId,
              reply: 'continued',
              toolCalls: 0,
            }),
          )
        }),
      ),
    60_000,
  )

  it.live(
    'ends a tool crash loop at Pi’s default limit and answers the next message',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const given = yield* world()
          const first = yield* processOn(given, 'tool')
          yield* first.ready
          // The tool may kill the process before the admission response arrives; its input is durable.
          yield* first.admit('crashing', 'one').pipe(Effect.exit)
          expect(yield* first.exit).toEqual([null, 'SIGKILL'])
          for (let restart = 1; restart < 5; restart++) {
            const crashing = yield* processOn(given, 'tool')
            expect(yield* crashing.exit).toEqual([null, 'SIGKILL'])
          }
          const after = yield* processOn(given, 'resume')
          yield* after.ready
          const input = yield* after.admit('crashing', 'one')
          expect(input.repeated).toBe(true)
          expect(RuntimeSettlement.guards.Failed(yield* after.settled(input.submissionId))).toBe(
            true,
          )
          const viewed = yield* after
            .request(`${thread}/state`)
            .pipe(Effect.flatMap((answer) => state(answer.body)))
          expect(viewed.settlements).toContainEqual({
            submissionId: String(input.submissionId),
            outcome: 'failed',
          })
          const next = yield* after.admit('next', 'two')
          expect(yield* after.settled(next.submissionId)).toEqual(
            RuntimeSettlement.cases.Done.make({
              answeredBy: next.submissionId,
              reply: 'continued',
              toolCalls: 0,
            }),
          )
          expect(after.output().match(/Reply ended after repeated runtime crashes/gu)).toHaveLength(
            1,
          )
          expect(after.output()).toContain('pi.tool')
          expect(after.output()).toContain(ada)
        }),
      ),
    60_000,
  )

  it.live(
    'answers an input queued behind a model error without a further message',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const given = yield* world()
          const runtime = yield* processOn(given, 'failure')
          yield* runtime.ready
          const first = yield* runtime.admit('first', 'one')
          yield* runtime.model
          const next = yield* runtime.admit('next', 'two')
          yield* runtime.release
          expect(yield* runtime.settled(first.submissionId)).toEqual(
            RuntimeSettlement.cases.Failed.make({ failure: 'ModelUnavailable', status: 401 }),
          )
          expect(yield* runtime.settled(next.submissionId)).toEqual(
            RuntimeSettlement.cases.Done.make({
              answeredBy: next.submissionId,
              reply: 'next answered',
              toolCalls: 0,
            }),
          )
        }),
      ),
    60_000,
  )
})

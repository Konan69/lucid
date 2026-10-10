import { describe, expect, it } from '@effect/vitest'
import { PersonId, Routine, RoutineId, RoutineTrigger, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { routineTools } from './routines.ts'
import { Scope, toolRunner } from './scope.ts'

const context = {
  toolCallId: 'PRIVATE-call',
  signal: new AbortController().signal,
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}
const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Json, terminate: Schema.Boolean }),
)
type RpcExit = RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>['exit']

/** Use real Flue callbacks and generated RPC requests; only server responses are controlled. */
const fixture = Effect.fn('RoutineToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const scope = Layer.succeed(
    Scope,
    Scope.of({
      acting: {
        personId: PersonId.make('PRIVATE-person'),
        threadId: ThreadId.make('PRIVATE-thread'),
      },
      client: rpc.client,
      folder: Option.none(),
    }),
  )
  const [create, find] = routineTools(toolRunner(scope))
  /** Typed protocol responses preserve the transport boundary rather than mocking a tool method. */
  const reply = Effect.fn('RoutineToolsTest.reply')(function* (
    tag: string,
    payload: Schema.Json,
    exit: RpcExit,
  ) {
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
    expect(request.tag).toBe(tag)
    expect(request.payload).toEqual(payload)
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- The SDK protocol has no envelope constructor in rc.116.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit,
    })
  })
  return {
    create: (data: Parameters<typeof create.run>[0]['data']) =>
      Effect.promise(() => Promise.resolve(create.run({ ...context, data }))).pipe(
        Effect.flatMap(decodeOutput),
      ),
    find: (account: string) =>
      Effect.promise(() =>
        Promise.resolve(
          find.run({ ...context, data: { summary: 'Available mail events', account } }),
        ),
      ).pipe(Effect.flatMap(decodeOutput)),
    reply,
  }
})

/** The model sees only readable Routine metadata, never the Person/Thread/Connection/receipt authority. */
describe('Integration Routine tools', () => {
  it.effect('find_events exposes readable provider events for an account name', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const events = [
          {
            event: 'mail.received',
            description: 'A new email arrives',
            filter: { type: 'object' },
          },
        ]
        const [result] = yield* Effect.all(
          [
            tools.find('Gmail (Work)'),
            tools.reply('FindEvents', { account: 'Gmail (Work)' }, Exit.succeed({ events })),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toEqual({ events })
        expect(JSON.stringify(result)).not.toContain('PRIVATE-')
      }),
    ),
  )

  it.effect(
    'create_routine carries account/event/filter and projects a reference-free result',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const trigger = RoutineTrigger.cases.Integration.make({
            account: 'Gmail (Work)',
            event: 'A new email arrives',
            filter: { from: 'dami@example.test' },
          })
          const name = 'Summarize new mail'
          const prompt = 'Summarize it for me.'
          const routine = Routine.make({
            id: RoutineId.make('PRIVATE-routine'),
            name,
            prompt,
            trigger,
            libraryFolderId: null,
            enabled: true,
            nextExpectedAt: 300_000,
            lastMissedAt: null,
            createdAt: 0,
            updatedAt: 0,
            nextRunAt: 300_000,
            runs: [],
          })
          const [result] = yield* Effect.all(
            [
              tools.create({
                summary: 'Future work',
                name,
                prompt,
                trigger: {
                  kind: 'Integration',
                  account: trigger.account,
                  event: trigger.event,
                  filter: trigger.filter,
                },
              }),
              tools.reply('CreateRoutine', { name, prompt, trigger }, Exit.succeed({ routine })),
            ],
            { concurrency: 2 },
          )
          expect(JSON.stringify(result)).not.toContain('PRIVATE-')
          expect(result.output).toMatchObject({
            name,
            prompt,
            schedule: 'when A new email arrives happens in Gmail (Work)',
          })
        }),
      ),
  )

  it.effect('one-off creation sends local words to server timezone resolution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const name = 'Check the report'
        const prompt = 'Remind me to check the report.'
        const at = Date.UTC(2026, 9, 4, 8)
        const routine = Routine.make({
          id: RoutineId.make('PRIVATE-routine'),
          name,
          prompt,
          trigger: RoutineTrigger.cases.Once.make({ at, timezone: 'Africa/Lagos' }),
          libraryFolderId: null,
          enabled: true,
          nextExpectedAt: at,
          lastMissedAt: null,
          createdAt: 0,
          updatedAt: 0,
          nextRunAt: at,
          runs: [],
        })
        const [result] = yield* Effect.all(
          [
            tools.create({
              summary: 'Future work',
              name,
              prompt,
              trigger: { kind: 'Once', localAt: '2026-10-04T09:00' },
            }),
            tools.reply(
              'CreateOnceRoutine',
              { name, prompt, localAt: '2026-10-04T09:00' },
              Exit.succeed({ routine }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toMatchObject({ name, nextRunAt: '2026-10-04T08:00:00.000Z' })
        expect(JSON.stringify(result)).not.toContain('PRIVATE-')
        expect(JSON.stringify(result)).not.toContain(String(at))
      }),
    ),
  )

  it.effect('scheduled creation retains the explicit cron and timezone path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const trigger = RoutineTrigger.cases.Schedule.make({
          cron: '0 9 * * *',
          timezone: 'Africa/Lagos',
        })
        const name = 'Morning review'
        const prompt = 'Review my day.'
        const routine = Routine.make({
          id: RoutineId.make('PRIVATE-routine'),
          name,
          prompt,
          trigger,
          libraryFolderId: null,
          enabled: true,
          nextExpectedAt: 300_000,
          lastMissedAt: null,
          createdAt: 0,
          updatedAt: 0,
          nextRunAt: 300_000,
          runs: [],
        })
        const [result] = yield* Effect.all(
          [
            tools.create({
              summary: 'Future work',
              name,
              prompt,
              trigger: { kind: 'Schedule', cron: trigger.cron, timezone: trigger.timezone },
            }),
            tools.reply('CreateRoutine', { name, prompt, trigger }, Exit.succeed({ routine })),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toMatchObject({
          schedule: { cron: trigger.cron, timezone: trigger.timezone },
        })
      }),
    ),
  )
})

import { describe, expect, it } from '@effect/vitest'
import { PersonId, ThreadId, Watch, WatchId, WatchState } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { Scope, toolRunner } from './scope.ts'
import { watchTools } from './watches.ts'

const context = {
  toolCallId: 'PRIVATE-call',
  signal: new AbortController().signal,
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}
const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Json, terminate: Schema.Boolean }),
)
type RpcExit = RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>['exit']

const watch = Watch.make({
  id: WatchId.make('PRIVATE-watch'),
  name: 'New mail in Work Gmail',
  account: 'Gmail (Work)',
  event: 'message.received',
  arguments: { folder: 'inbox' },
  instruction: 'Tell me when a client writes.',
  state: WatchState.cases.Active.make({ refreshBefore: 604_800_000 }),
  createdAt: 0,
})

/** Real Flue callbacks and generated RPC requests; only the server's answers are the test's. */
const fixture = Effect.fn('WatchToolsTest.fixture')(function* () {
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
    }),
  )
  const [find, create, list, stop] = watchTools(toolRunner(scope))
  /** Answer the next request after checking it is the call and payload the tool should make. */
  const reply = Effect.fn('WatchToolsTest.reply')(function* (
    tag: string,
    payload: Option.Option<Schema.Json>,
    exit: RpcExit,
  ) {
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
    expect(request.tag).toBe(tag)
    expect(Option.fromUndefinedOr(request.payload)).toEqual(payload)
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- The SDK protocol has no envelope constructor.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit,
    })
  })
  /** Run a tool exactly as Flue does, then decode its model-visible result. */
  const output = <A>(result: A | PromiseLike<A>) =>
    Effect.promise(() => Promise.resolve(result)).pipe(Effect.flatMap(decodeOutput))
  return {
    find: (data: Parameters<typeof find.run>[0]['data']) => output(find.run({ ...context, data })),
    create: (data: Parameters<typeof create.run>[0]['data']) =>
      output(create.run({ ...context, data })),
    list: (data: Parameters<typeof list.run>[0]['data']) => output(list.run({ ...context, data })),
    stop: (data: Parameters<typeof stop.run>[0]['data']) => output(stop.run({ ...context, data })),
    reply,
  }
})

/** The model sees names and words; the Watch's id and the Person's identity never reach it. */
describe('Watch tools', () => {
  it.effect('find_events asks by account name and shows events in words', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const events = [
          {
            event: 'message.received',
            description: 'A message arrived.',
            filters: [{ name: 'folder', type: 'string' }],
          },
        ]
        const [result] = yield* Effect.all(
          [
            tools.find({ summary: 'Mail events', account: 'Gmail (Work)' }),
            tools.reply(
              'FindAppEvents',
              Option.some({ account: 'Gmail (Work)' }),
              Exit.succeed({ events }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toEqual({ events })
      }),
    ),
  )

  it.effect('watch sends names and filters, and answers without the Watch id', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const [result] = yield* Effect.all(
          [
            tools.create({
              summary: 'Watch work mail',
              name: ' New mail in Work Gmail ',
              account: 'Gmail (Work)',
              event: 'message.received',
              filters: { folder: 'inbox' },
              instruction: 'Tell me when a client writes.',
            }),
            tools.reply(
              'CreateWatch',
              Option.some({
                name: 'New mail in Work Gmail',
                account: 'Gmail (Work)',
                event: 'message.received',
                arguments: { folder: 'inbox' },
                instruction: 'Tell me when a client writes.',
              }),
              Exit.succeed({ watch }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toEqual({
          name: 'New mail in Work Gmail',
          watching: 'message.received in Gmail (Work)',
          filters: { folder: 'inbox' },
          instruction: 'Tell me when a client writes.',
          state: 'watching',
        })
        expect(JSON.stringify(result)).not.toContain('PRIVATE-')
      }),
    ),
  )

  it.effect('list_watches and stop_watching speak by name', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const [listed] = yield* Effect.all(
          [
            tools.list({ summary: 'What I watch' }),
            tools.reply('ListWatches', Option.none(), Exit.succeed({ watches: [watch] })),
          ],
          { concurrency: 2 },
        )
        expect(JSON.stringify(listed)).not.toContain('PRIVATE-')
        const stopped = Watch.make({
          ...watch,
          state: WatchState.cases.Stopped.make({ reason: 'removed' }),
        })
        const [result] = yield* Effect.all(
          [
            tools.stop({ summary: 'Stop watching mail', name: 'New mail in Work Gmail' }),
            tools.reply(
              'StopWatch',
              Option.some({ name: 'New mail in Work Gmail' }),
              Exit.succeed({ watch: stopped }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toMatchObject({ name: 'New mail in Work Gmail', state: 'stopped' })
      }),
    ),
  )
})

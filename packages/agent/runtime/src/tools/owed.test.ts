import { describe, expect, it } from '@effect/vitest'
import { Owed, OwedId, OwedListResponse, OwedState, PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Predicate, Queue, Struct } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { owedTools } from './owed.ts'
import { Scope, toolRunner } from './scope.ts'

/** Exercise the generated RPC client and real tool runner; responses are deliberate transport fixtures. */
const fixture = Effect.fn('OwedToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const personId = PersonId.make('fixture-person')
  const threadId = ThreadId.make('fixture-thread')
  const scope = Layer.succeed(
    Scope,
    Scope.of({ acting: { personId, threadId }, client: rpc.client }),
  )
  const [track, , resolve] = owedTools(toolRunner(scope), 'Africa/Lagos')
  const context = {
    signal: yield* Effect.abortSignal,
    toolCallId: 'owed-call',
    log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
  }
  const record = Owed.make({
    id: OwedId.make('fixture-owed'),
    personId,
    threadId,
    what: 'the signed NDA',
    from: 'Dana',
    since: Date.parse('2026-10-26T08:00:00Z'),
    due: null,
    blockedOn: null,
    nextStep: 'Ask Dana on Friday',
    state: OwedState.cases.Open.make({}),
    updatedAt: 100,
  })
  return { requests, rpc, track, resolve, context, record }
})

/** SDK wire Exit has no constructor. The test replies at the real client's transport boundary. */
const answer = Effect.fn('OwedToolsTest.answer')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
  tag: string,
  output: Owed | OwedListResponse,
) {
  const request = yield* Queue.take(test.requests)
  if (!Predicate.isTagged(request, 'Request'))
    return yield* Effect.sync(() => expect.fail('Expected an RPC request'))
  expect(request.tag).toBe(tag)
  yield* test.rpc.write({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelope has no constructor.
    _tag: 'Exit',
    clientId: 0,
    requestId: request.id,
    exit: Exit.succeed(output),
  })
  return request.payload
})

/** The model supplies words; the tools supply Thread authority, zoned timestamps and the resolved id. */
describe('Owed tools', () => {
  it.effect('tracks through RPC and resolves the open record by what and from', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const tracked = yield* Effect.promise(() =>
        Promise.resolve(
          test.track.run({
            ...test.context,
            data: {
              summary: 'Track Dana’s NDA',
              what: test.record.what,
              from: test.record.from,
              since: '2026-10-26T09:00:00',
              due: null,
              nextStep: test.record.nextStep,
            },
          }),
        ),
      ).pipe(Effect.forkScoped)
      expect(yield* answer(test, 'TrackOwed', test.record)).toEqual({
        threadId: test.record.threadId,
        what: test.record.what,
        from: test.record.from,
        since: Date.parse('2026-10-26T08:00:00Z'),
        due: null,
        nextStep: test.record.nextStep,
      })
      expect(yield* Fiber.join(tracked)).toMatchObject({
        output: { ok: true, what: test.record.what, from: test.record.from },
      })
      const resolved = Owed.make(
        Struct.assign(test.record, {
          state: OwedState.cases.Resolved.make({ at: 200, how: 'Dana sent the signed PDF' }),
        }),
      )
      const resolution = yield* Effect.promise(() =>
        Promise.resolve(
          test.resolve.run({
            ...test.context,
            data: {
              summary: 'Close Dana’s NDA',
              what: 'THE SIGNED NDA',
              from: 'dana',
              how: 'Dana sent the signed PDF',
            },
          }),
        ),
      ).pipe(Effect.forkScoped)
      yield* answer(test, 'ListOwed', OwedListResponse.make({ owed: [test.record] }))
      expect(yield* answer(test, 'ResolveOwed', resolved)).toEqual({
        id: test.record.id,
        how: 'Dana sent the signed PDF',
      })
      expect(yield* Fiber.join(resolution)).toMatchObject({
        output: { ok: true, state: { status: 'resolved', how: 'Dana sent the signed PDF' } },
      })
      const ambiguous = yield* Effect.promise(() =>
        Promise.resolve(
          test.resolve.run({
            ...test.context,
            data: {
              summary: 'Close Dana’s NDA',
              what: test.record.what,
              from: test.record.from,
              how: 'Arrived',
            },
          }),
        ),
      ).pipe(Effect.forkScoped)
      yield* answer(
        test,
        'ListOwed',
        OwedListResponse.make({
          owed: [
            test.record,
            Owed.make(Struct.assign(test.record, { id: OwedId.make('duplicate') })),
          ],
        }),
      )
      expect(yield* Fiber.join(ambiguous)).toMatchObject({
        output: { ok: false, message: expect.stringContaining('the signed NDA') },
      })
    }).pipe(Effect.scoped),
  )
})

import { describe, expect, it } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import { DatabaseUnavailable, DeliveryScope, PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { cachedAuthority, recordScope, resolveAuthority } from './delivery.ts'

/** Recovery crosses the generated client; the controlled transport delays and fails real lookup requests. */
describe('delivery authority recovery', () => {
  it.effect('shares concurrent recovery, retries a failed lookup and caches only success', () =>
    Effect.gen(function* () {
      const requests =
        yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
      const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
        onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
      })
      const thread = ThreadId.make(crypto.randomUUID())
      const delivery = {
        kind: 'signal' as const,
        type: 'message',
        body: 'Read mail.',
        attributes: { turn: '1' },
      }
      const recover = resolveAuthority(thread, delivery, Option.none()).pipe(
        Effect.provideService(VividRpcClient, rpc.client),
      )
      const first = yield* recover.pipe(Effect.result, Effect.forkScoped)
      const failed = yield* Queue.take(requests)
      if (!Predicate.isTagged(failed, 'Request')) expect.fail('Expected an RPC request')
      expect(failed.tag).toBe('GetDeliveryScope')
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
        _tag: 'Exit',
        clientId: 0,
        requestId: failed.id,
        exit: Exit.fail(new DatabaseUnavailable({ message: 'Transient scope lookup failure' })),
      })
      yield* Fiber.join(first)
      const concurrent = yield* Effect.all([recover, recover], { concurrency: 2 }).pipe(
        Effect.forkScoped,
      )
      const retried = yield* Queue.take(requests)
      if (!Predicate.isTagged(retried, 'Request')) expect.fail('Expected an RPC request')
      expect(retried.tag).toBe('GetDeliveryScope')
      expect(retried.payload).toEqual({ threadId: thread, turn: 1 })
      const scope = DeliveryScope.make({
        acting: PersonId.make('MARK-person'),
        libraryFolder: null,
      })
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
        _tag: 'Exit',
        clientId: 0,
        requestId: retried.id,
        exit: Exit.succeed(scope),
      })
      const results = yield* Fiber.join(concurrent)
      expect(results).toEqual([results[0], results[0]])
      expect(yield* recover).toEqual({
        acting: { threadId: thread, personId: scope.acting },
        folder: Option.none(),
      })
      expect(yield* Queue.size(requests)).toBe(0)
    }).pipe(Effect.scoped),
  )

  it('evicts the oldest synchronous scope while keeping newer deliveries available', () => {
    const thread = ThreadId.make(crypto.randomUUID())
    const scope = DeliveryScope.make({ acting: PersonId.make('MARK-person'), libraryFolder: null })
    for (let turn = 1; turn <= 513; turn++) recordScope(thread, turn, scope)
    const signal = (turn: number) => ({
      kind: 'signal' as const,
      type: 'message',
      body: '',
      attributes: { turn: String(turn) },
    })
    expect(cachedAuthority(thread, signal(1), Option.none())).toEqual(Option.none())
    expect(Option.isSome(cachedAuthority(thread, signal(513), Option.none()))).toBe(true)
  })
})

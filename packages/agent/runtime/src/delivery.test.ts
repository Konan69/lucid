import { describe, expect, it } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  DatabaseUnavailable,
  DeliveryScope,
  LibraryFolderId,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Option, Predicate, Queue, Result } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { cachedAuthority, recordScope, recoverAuthority, resolveAuthority } from './delivery.ts'

/** Recovery crosses the generated client; the controlled transport delays and fails real lookup requests. */
describe('delivery authority recovery', () => {
  it.effect('shares concurrent recovery, retries a failed lookup and caches only success', () =>
    Effect.gen(function* () {
      // Both scopes share the same recovery policy; a missing folder must stay absent and a
      // Scoped folder must survive, without duplicating the entire RPC scenario elsewhere.
      for (const { libraryFolder, folder } of [
        { libraryFolder: null, folder: Option.none<LibraryFolderId>() },
        {
          libraryFolder: LibraryFolderId.make('69d8a703-98ad-41e7-a584-390a472a6637'),
          folder: Option.some(LibraryFolderId.make('69d8a703-98ad-41e7-a584-390a472a6637')),
        },
      ]) {
        yield* Effect.gen(function* () {
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
          const recover = resolveAuthority(thread, delivery, Option.none(), recoverAuthority).pipe(
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
          const rejected = yield* Fiber.join(first)
          expect(Result.isFailure(rejected) && rejected.failure).toBeInstanceOf(DatabaseUnavailable)
          const concurrent = yield* Effect.all([recover, recover], { concurrency: 2 }).pipe(
            Effect.forkScoped,
          )
          const retried = yield* Queue.take(requests)
          if (!Predicate.isTagged(retried, 'Request')) expect.fail('Expected an RPC request')
          expect(retried.tag).toBe('GetDeliveryScope')
          expect(retried.payload).toEqual({ threadId: thread, turn: 1 })
          const scope = DeliveryScope.make({
            acting: PersonId.make('MARK-person'),
            libraryFolder,
          })
          yield* rpc.write({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
            _tag: 'Exit',
            clientId: 0,
            requestId: retried.id,
            exit: Exit.succeed(scope),
          })
          const results = yield* Fiber.join(concurrent)
          const expected = {
            acting: { threadId: thread, personId: scope.acting },
            folder,
          }
          expect(results).toEqual([expected, expected])
          expect(yield* recover).toEqual(expected)
          expect(yield* Queue.size(requests)).toBe(0)
        }).pipe(Effect.scoped)
      }
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

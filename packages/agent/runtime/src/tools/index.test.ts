import { unusedMemory, unusedTranscripts } from './tests/harness.ts'
import { describe, expect, it } from '@effect/vitest'
import { PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { tools } from './index.ts'
import { Scope, type ResolveScope } from './scope.ts'
import { roundTrip } from './tests/harness.ts'

/** A scoped real RPC client per Person lets two concurrent Harness calls prove authority and
 * resource lifetimes without substituting a tool or making any HTTP/database request. */
const fixture = Effect.fn('CatalogueTest.fixture')(function* (person: string) {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  let active = false
  const layer = Layer.effect(
    Scope,
    Effect.acquireRelease(
      Effect.sync(() => {
        active = true
        return Scope.of({
          acting: { personId: PersonId.make(person), threadId: ThreadId.make('catalogue-thread') },

          client: rpc.client,
          timezone: '',
        })
      }),
      () =>
        Effect.sync(() => {
          active = false
        }),
    ),
  )
  /** Replies are generated protocol exits; the real client performs the response decoding. */
  const respond = Effect.fn('CatalogueTest.respond')(function* (
    request: RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>,
  ) {
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected a request.')
    expect(active).toBe(true)
    expect(request.tag).toBe('SearchLibrary')
    expect(request.payload).toEqual({ query: 'Agreement', limit: 6 })
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelopes have no constructor.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit: Exit.succeed({ results: [] }),
    })
  })
  return { layer, requests, respond, active: () => active }
})

describe('core tool catalogue', () => {
  it.effect(
    'keeps acting scopes separate and alive for concurrent calls through the exported factory',
    () =>
      Effect.gen(function* () {
        const ada = yield* fixture('ada')
        const dami = yield* fixture('dami')
        const calls: Parameters<ResolveScope>[0][] = []
        const definitions = tools(
          (call) => {
            calls.push(call)
            return calls.length === 1 ? ada.layer : dami.layer
          },
          () => Effect.die('Unexpected memory authority'),
          { memory: unusedMemory, transcripts: unusedTranscripts },
          [],
        ).tools
        expect(calls).toHaveLength(0)
        expect(definitions.slice(0, 9).map((tool) => tool.name)).toEqual([
          'read',
          'write',
          'edit',
          'bash',
          'grep',
          'glob',
          'use_desktop',
          'browse',
          'use_person_computer',
        ])
        const search = definitions.find((tool) => tool.name === 'search_library')
        if (search === undefined) expect.fail('Missing Library tool.')
        const signal = yield* Effect.abortSignal
        const args = { summary: 'Find the agreement', query: 'Agreement', limit: 6 }
        const first = yield* Effect.promise(() => roundTrip(search, args, signal)).pipe(
          Effect.forkScoped,
        )
        const firstRequest = yield* Queue.take(ada.requests)
        const second = yield* Effect.promise(() => roundTrip(search, args, signal)).pipe(
          Effect.forkScoped,
        )
        const secondRequest = yield* Queue.take(dami.requests)
        expect(ada.active()).toBe(true)
        expect(dami.active()).toBe(true)
        yield* dami.respond(secondRequest)
        const secondResult = yield* Fiber.join(second)
        expect(secondResult.message.details).toEqual({
          customTool: 'search_library',
          output: { results: [] },
        })
        expect(dami.active()).toBe(false)
        expect(ada.active()).toBe(true)
        yield* ada.respond(firstRequest)
        const firstResult = yield* Fiber.join(first)
        expect(firstResult.message.details).toEqual(secondResult.message.details)
        expect(ada.active()).toBe(false)
        expect(calls).toHaveLength(2)
      }),
  )
})

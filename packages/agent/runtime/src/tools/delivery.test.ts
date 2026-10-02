import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  DeliveryScope,
  LibraryFolderId,
  PersonId,
  RuntimeRunRequest,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { DeliveryMessage } from '../../../../../apps/server/src/threads/conversation.ts'
import { flueMessage } from '../../../../../apps/server/src/threads/message.ts'
import { cachedAuthority, modelDelivery, recordScope, resolveAuthority } from '../delivery.ts'

const marker = '69d8a703-98ad-41e7-a584-390a472a6637'
const scope = DeliveryScope.make({
  acting: PersonId.make('MARK-person'),
  libraryFolder: LibraryFolderId.make(marker),
})

/** Mirrors Flue 2.1's renderSignalMessage: every attribute is rendered, so inspect text, not just schemas. */
function modelText(message: ReturnType<typeof modelDelivery>) {
  if (message.kind === 'user') return message.body
  return `<${message.tagName} type="${message.type}"${Object.entries(message.attributes)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('')}>\n${message.body}\n</${message.tagName}>`
}

describe('delivery authority outside model text', () => {
  it('renders every server delivery kind without identifiers and keeps authority out of Flue history', () => {
    const messages = [
      DeliveryMessage.cases.Said.make({ body: 'Please review this.' }),
      DeliveryMessage.cases.Signal.make({
        type: 'schedule',
        body: "Search this Routine's Library folder and cite every source used.",
        attributes: { routine: 'MARK-routine', name: 'Morning review', libraryFolder: marker },
      }),
      DeliveryMessage.cases.Signal.make({
        type: 'follow-up',
        body: 'Check the signed agreement.',
        attributes: { task: 'MARK-task' },
      }),
      DeliveryMessage.cases.Signal.make({
        type: 'approval',
        body: 'The Person approved the action.',
        attributes: { approval: marker, outcome: 'approved' },
      }),
      DeliveryMessage.cases.Signal.make({
        type: 'answer',
        body: 'Use the first draft.',
        attributes: { request: 'MARK-request' },
      }),
    ]
    for (const [index, message] of messages.entries()) {
      const turn = index + 1
      const sent = flueMessage('people', 'Ada', message, turn)
      if (sent.kind !== 'signal' || sent.attributes === undefined)
        expect.fail('Shared deliveries must be signals')
      const request = RuntimeRunRequest.make({
        threadId: ThreadId.make('MARK-thread'),
        idempotencyKey: 'MARK-key',
        type: DeliveryMessage.guards.Said(message) ? 'message' : message.type,
        body: sent.body,
        attributes: sent.attributes,
        turn,
        scope,
      })
      const forwarded = modelDelivery(request)
      expect(modelText(forwarded)).not.toMatch(
        /MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu,
      )
      expect(JSON.stringify(forwarded)).not.toContain(marker)
      expect(JSON.stringify(forwarded)).not.toContain('scope')
      expect(forwarded.kind === 'signal' && forwarded.attributes.turn).toBe(String(turn))
    }
  })

  it('a render misses after restart; private words still use creator authority without attributes', () => {
    const threadId = ThreadId.make('unprepared-thread')
    const signal = {
      kind: 'signal' as const,
      type: 'schedule',
      body: 'Review.',
      attributes: { turn: '1' },
    }
    expect(cachedAuthority(threadId, signal, Option.none())).toEqual(Option.none())
    expect(
      cachedAuthority(
        threadId,
        { kind: 'user', body: 'Review.' },
        Option.some({ creator: scope.acting, creatorName: 'Ada' }),
      ),
    ).toEqual(Option.some({ acting: { threadId, personId: scope.acting }, folder: Option.none() }))
    recordScope(threadId, 1, scope)
    expect(cachedAuthority(threadId, signal, Option.none())).toEqual(
      Option.some({
        acting: { threadId, personId: scope.acting },
        folder: Option.some(scope.libraryFolder),
      }),
    )
  })

  it.effect(
    'concurrent tool calls recover one persisted scope and cache it across subsequent renders',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests =
            yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
          const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
            onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
          })
          const threadId = ThreadId.make('restart-recovery-thread')
          const delivery = {
            kind: 'signal' as const,
            type: 'schedule',
            body: 'Review.',
            attributes: { turn: '4' },
          }
          const recover = resolveAuthority(threadId, delivery, Option.none()).pipe(
            Effect.provide(Layer.succeed(VividRpcClient, rpc.client)),
          )
          const answer = Effect.fn('Test.DeliveryScope.answer')(function* () {
            const request = yield* Queue.take(requests)
            if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected a scope request')
            expect(request.tag).toBe('GetDeliveryScope')
            expect(request.payload).toEqual({ threadId, turn: 4 })
            yield* rpc.write({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelope has no constructor in rc.116.
              _tag: 'Exit',
              clientId: 0,
              requestId: request.id,
              exit: Exit.succeed(scope),
            })
          })
          const [first, second] = yield* Effect.all([recover, recover, answer()], {
            concurrency: 'unbounded',
          })
          expect(first).toEqual(second)
          expect(first.folder).toEqual(Option.some(scope.libraryFolder))
          expect(yield* recover).toEqual(first)
          expect(cachedAuthority(threadId, delivery, Option.none())).toEqual(Option.some(first))
          expect(yield* Queue.size(requests)).toBe(0)
        }),
      ),
  )
})

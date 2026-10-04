import { expect, it } from '@effect/vitest'
import { ConnectionMatch, PersonId, ServiceAuthorization, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { connectionTools } from './connections.ts'
import { Scope, toolRunner } from './scope.ts'

/** The public Flue tool runs through the real generated RPC client and production projection.
 * Only the remote server receipt is controlled; unavailable setup must never become a card. */
it.effect(
  'tells the model that catalogue setup belongs to the operator without a connect card',
  () =>
    Effect.gen(function* () {
      const requests =
        yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
      const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
        onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
      })
      const scope = Layer.succeed(
        Scope,
        Scope.of({
          acting: {
            personId: PersonId.make('fixture-person'),
            threadId: ThreadId.make('fixture-thread'),
          },
          client: rpc.client,
          folder: Option.none(),
        }),
      )
      const [, , , tool] = connectionTools(toolRunner(scope))
      expect(tool.name).toBe('find_integrations')
      const running = yield* Effect.promise(() =>
        Promise.resolve(
          tool.run({
            data: { query: 'Google' },
            signal: new AbortController().signal,
            toolCallId: 'fixture-call',
            log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
          }),
        ),
      ).pipe(Effect.forkScoped)
      const request = yield* Queue.take(requests)
      if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected RPC request')
      expect(request.tag).toBe('FindIntegrations')
      expect(request.payload).toEqual({ query: 'Google' })
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor in rc.116.
        _tag: 'Exit',
        clientId: 0,
        requestId: request.id,
        exit: Exit.succeed({
          catalog: 'available',
          omittedAccounts: 0,
          integrations: [
            ConnectionMatch.cases.Catalog.make({
              name: 'Google Calendar',
              description: 'Manage your calendar',
              connected: false,
              authorization: ServiceAuthorization.cases.SetupRequired.make({}),
            }),
          ],
        }),
      })
      const result = yield* Fiber.join(running)
      if (!Predicate.isObject(result) || !('output' in result)) expect.fail('Expected tool output')
      expect(result.output).toMatchObject({
        catalog: 'available',
        integrations: [{ name: 'Google Calendar', connected: false }],
      })
      const output = JSON.stringify(result.output)
      expect(output).toContain('not set up on this Vivid yet')
      expect(output).toContain('Google Calendar is not set up on this Vivid yet')
      expect(output).toContain('whoever runs it needs to register a sign-in application for it')
      expect(output).toContain('Do not offer a connect card')
      expect(output).not.toContain('connection-request')
      expect(output).not.toContain('fixture-person')
      expect(yield* Queue.size(requests)).toBe(0)
    }).pipe(Effect.scoped),
)

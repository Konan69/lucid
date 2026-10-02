import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, ConnectionTool, PersonId, ThreadId, ToolOutcome } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { connectionTools } from './connections.ts'
import { Scope, toolRunner } from './scope.ts'

/** Exercise the real Flue callback, generated client and projection; control only the RPC transport. */
describe('connected tool execution', () => {
  it.effect(
    'resolves an exact pair and preserves bounded provider record ids and email addresses',
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
              threadId: ThreadId.make('MARK-thread'),
              personId: PersonId.make('MARK-person'),
            },
            client: rpc.client,
            folder: Option.none(),
          }),
        )
        const [, use] = connectionTools(toolRunner(scope))
        const call = yield* Effect.promise(() =>
          Promise.resolve(
            use.run({
              data: {
                account: 'Mail',
                tool: 'get_message',
                input: { id: 'provider-message' },
                summary: 'Read mail',
                rationale: 'Answer the question',
              },
              signal: new AbortController().signal,
              toolCallId: 'MARK-call',
              log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
            }),
          ),
        ).pipe(Effect.forkScoped)
        const resolve = yield* Queue.take(requests)
        if (!Predicate.isTagged(resolve, 'Request')) expect.fail('Expected an RPC request')
        expect(resolve.tag).toBe('ResolveTool')
        expect(resolve.payload).toEqual({ account: 'Mail', tool: 'get_message' })
        const tool = ConnectionTool.make({
          connectionId: ConnectionId.make('MARK-connection'),
          account: 'Mail',
          name: 'get_message',
          description: 'Read mail',
          effect: 'read',
          input: {},
        })
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: resolve.id,
          exit: Exit.succeed(tool),
        })
        const execute = yield* Queue.take(requests)
        if (!Predicate.isTagged(execute, 'Request')) expect.fail('Expected an RPC request')
        expect(execute.tag).toBe('UseTool')
        expect(execute.payload).toMatchObject({
          connectionId: tool.connectionId,
          tool: tool.name,
          input: { id: 'provider-message' },
        })
        const output = {
          id: 'provider-message',
          eventId: '37e21f26-63ed-4075-aad1-0118929da0ac',
          email: 'ada@example.test',
          imageUrl: 'https://example.test/avatar.png',
          rows: [{ sender_email: 'dami@example.test', text: 'x'.repeat(4100) }],
        }
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: execute.id,
          exit: Exit.succeed(ToolOutcome.cases.Completed.make({ output })),
        })
        const result = yield* Fiber.join(call)
        if (!Predicate.isObject(result) || !('output' in result))
          expect.fail('Expected tool output')
        expect(result.output).toMatchObject({
          ok: true,
          output: {
            ...output,
            rows: [{ sender_email: 'dami@example.test', text: 'x'.repeat(4000), truncated: true }],
            truncated: true,
          },
          truncated: true,
        })
        expect(JSON.stringify(result.output)).not.toContain('MARK-')
      }).pipe(Effect.scoped),
  )
})

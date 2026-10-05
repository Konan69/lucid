import { describe, expect, it } from '@effect/vitest'
import {
  AddIntegrationOutcome,
  ApprovalId,
  Connection,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  ServiceId,
  TestIntegrationOutcome,
  ConnectionId,
  ConnectionTool,
  ServiceAuthorization,
  PersonId,
  ThreadId,
  ToolOutcome,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { connectionTools, decodeToolInput } from './connections.ts'
import { Scope, toolRunner } from './scope.ts'

/** Keep the generated RPC client intact; the controllable transport is the only test boundary. */
const fixture = Effect.fn('ConnectionToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
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
  return { requests, rpc, tools: connectionTools(toolRunner(scope)) }
})

/** Exercise the real Flue callback, generated client and projection; control only the RPC transport. */
describe('connected tool execution', () => {
  it.effect('ends an unconnected offer and keeps the secure card in the Thread result', () =>
    Effect.gen(function* () {
      const { requests, rpc, tools } = yield* fixture()
      const [, , connect] = tools
      const call = yield* Effect.promise(() =>
        Promise.resolve(
          connect.run({
            data: { summary: 'Ask to add Mail', service: 'Mail', reason: 'Read your latest mail' },
            signal: new AbortController().signal,
            toolCallId: 'MARK-call',
            log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
          }),
        ),
      ).pipe(Effect.forkScoped)
      const discovery = yield* Queue.take(requests)
      if (!Predicate.isTagged(discovery, 'Request')) expect.fail('Expected discovery')
      expect(discovery.tag).toBe('FindTools')
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelopes have no schema constructor.
        _tag: 'Exit',
        clientId: 0,
        requestId: discovery.id,
        exit: Exit.succeed({
          tools: [],
          unconnected: [
            {
              id: ServiceId.make('mail'),
              name: 'Mail',
              description: 'Your mail',
              mark: null,
              authorization: ServiceAuthorization.cases.None.make({}),
            },
          ],
        }),
      })
      const offer = yield* Queue.take(requests)
      if (!Predicate.isTagged(offer, 'Request')) expect.fail('Expected offer')
      expect(offer.tag).toBe('OfferConnection')
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelopes have no schema constructor.
        _tag: 'Exit',
        clientId: 0,
        requestId: offer.id,
        exit: Exit.succeed({
          kind: 'connection-request',
          service: ServiceId.make('mail'),
          serviceName: 'Mail',
          reason: 'Read your latest mail',
          ready: false,
        }),
      })
      expect(yield* Fiber.join(call)).toMatchObject({
        terminate: true,
        output: { kind: 'connection-request', service: 'mail', ready: false },
      })
    }).pipe(Effect.scoped),
  )
  it.effect(
    'registers a personal integration through the real runtime RPC seam using names only',
    () =>
      Effect.gen(function* () {
        const { requests, rpc, tools } = yield* fixture()
        const [, , , , add] = tools
        const call = yield* Effect.promise(() =>
          Promise.resolve(
            add.run({
              data: {
                summary: 'Add Work Records',
                address: 'https://records.example/mcp',
                name: 'Work Records',
              },
              signal: new AbortController().signal,
              toolCallId: 'MARK-call',
              log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
            }),
          ),
        ).pipe(Effect.forkScoped)
        const request = yield* Queue.take(requests)
        if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
        expect(request.tag).toBe('AddIntegration')
        expect(request.payload).toEqual({
          address: 'https://records.example/mcp',
          name: 'Work Records',
          shared: false,
        })
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: request.id,
          exit: Exit.succeed(AddIntegrationOutcome.cases.Added.make({ account: 'Work Records' })),
        })
        const result = yield* Fiber.join(call)
        expect(result).toEqual({
          output: { added: true, account: 'Work Records' },
          terminate: false,
        })
        expect(JSON.stringify(result)).not.toContain('MARK-')
      }).pipe(Effect.scoped),
  )
  it.effect(
    'explains an already-connected account through the real runtime RPC seam using names only',
    () =>
      Effect.gen(function* () {
        const { requests, rpc, tools } = yield* fixture()
        const [, , , , add] = tools
        const call = yield* Effect.promise(() =>
          Promise.resolve(
            add.run({
              data: {
                summary: 'Add Work Records',
                address: 'https://records.example/mcp',
                name: 'Work Records',
              },
              signal: new AbortController().signal,
              toolCallId: 'MARK-call',
              log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
            }),
          ),
        ).pipe(Effect.forkScoped)
        const request = yield* Queue.take(requests)
        if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
        expect(request.tag).toBe('AddIntegration')
        expect(request.payload).toEqual({
          address: 'https://records.example/mcp',
          name: 'Work Records',
          shared: false,
        })
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: request.id,
          exit: Exit.succeed(
            AddIntegrationOutcome.cases.AlreadyConnected.make({
              account: 'Work Records',
              name: 'Records',
            }),
          ),
        })
        const result = yield* Fiber.join(call)
        expect(result).toEqual({
          output: {
            alreadyConnected: true,
            // Service names identify the Integration; find_tools supplies usable account labels.
            message:
              'Records is already connected. Call find_tools to discover its tools and the account names you may use.',
          },
          terminate: false,
        })
        expect(JSON.stringify(result)).not.toContain('MARK-')
      }).pipe(Effect.scoped),
  )
  for (const kind of ['OpenSignIn', 'EnterKey'] as const) {
    it.effect(`stops the runtime turn for secure ${kind} completion`, () =>
      Effect.gen(function* () {
        const { requests, rpc, tools } = yield* fixture()
        const [, , , , add] = tools
        const call = yield* Effect.promise(() =>
          Promise.resolve(
            add.run({
              data: {
                summary: 'Add Work Records',
                address: 'https://records.example/mcp',
                name: 'Work Records',
              },
              signal: new AbortController().signal,
              toolCallId: 'MARK-call',
              log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
            }),
          ),
        ).pipe(Effect.forkScoped)
        const request = yield* Queue.take(requests)
        if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
        const connection = Connection.make({
          id: ConnectionId.make('MARK-connection'),
          service: ServiceId.make('MARK-service'),
          serviceName: 'Records',
          mark: null,
          label: 'Work Records',
          ownership: ConnectionOwnership.cases.Personal.make({
            owner: { id: PersonId.make('MARK-person'), name: 'Ada', image: null },
          }),
          state: ConnectionState.cases.NeedsAuthorization.make({}),
          createdAt: 1,
        })
        const outcome =
          kind === 'OpenSignIn'
            ? AddIntegrationOutcome.cases.NeedsSignIn.make({
                step: ConnectionStep.cases.OpenSignIn.make({
                  connection,
                  address: 'https://records.example/sign-in',
                }),
              })
            : AddIntegrationOutcome.cases.NeedsKey.make({
                step: ConnectionStep.cases.EnterKey.make({
                  connection,
                  fields: [{ name: 'key', label: 'API key' }],
                }),
              })
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: request.id,
          exit: Exit.succeed(outcome),
        })
        const result = yield* Fiber.join(call)
        expect(result).toMatchObject({
          terminate: true,
          output: { kind: 'connection-request', authorization: { _tag: kind } },
        })
        expect(JSON.stringify(result)).not.toContain('MARK-person')
      }).pipe(Effect.scoped),
    )
  }
  it.effect('stops a read test on the Gate approval receipt', () =>
    Effect.gen(function* () {
      const { requests, rpc, tools } = yield* fixture()
      const [, , , , , test] = tools
      const call = yield* Effect.promise(() =>
        Promise.resolve(
          test.run({
            data: { summary: 'Check Work Records', account: 'Work Records' },
            signal: new AbortController().signal,
            toolCallId: 'MARK-call',
            log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
          }),
        ),
      ).pipe(Effect.forkScoped)
      const request = yield* Queue.take(requests)
      if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
      expect(request.tag).toBe('TestIntegration')
      expect(request.payload).toEqual({ account: 'Work Records' })
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
        _tag: 'Exit',
        clientId: 0,
        requestId: request.id,
        exit: Exit.succeed(
          TestIntegrationOutcome.cases.ApprovalRequired.make({
            approvalId: ApprovalId.make('MARK-approval'),
            summary: 'Test Work Records',
          }),
        ),
      })
      const result = yield* Fiber.join(call)
      expect(result).toMatchObject({ terminate: true, output: { kind: 'approval-request' } })
    }).pipe(Effect.scoped),
  )
  it.effect(
    'resolves an exact pair and preserves bounded provider record ids and email addresses',
    () =>
      Effect.gen(function* () {
        const { requests, rpc, tools } = yield* fixture()
        const [, use] = tools
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
  it.effect('returns validation detail through use_tool so the model can correct its input', () =>
    Effect.gen(function* () {
      const { requests, rpc, tools } = yield* fixture()
      const [, use] = tools
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
      const problems = ['repoName: expected a string', 'question: required']
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
        _tag: 'Exit',
        clientId: 0,
        requestId: execute.id,
        exit: Exit.succeed(
          ToolOutcome.cases.Rejected.make({ message: 'Correct the input and retry', problems }),
        ),
      })
      const result = yield* Fiber.join(call)
      if (!Predicate.isObject(result) || !('output' in result)) expect.fail('Expected tool output')
      expect(result.output).toMatchObject({
        ok: false,
        problems,
        message: 'The service rejected the action: Correct the input and retry.',
      })
      expect(result).not.toHaveProperty('terminate', true)
      expect(JSON.stringify(result.output)).not.toContain('MARK-')
    }).pipe(Effect.scoped),
  )
})

describe('tool input from the model', () => {
  it.effect('reads JSON text that holds an object or array as that value', () =>
    Effect.gen(function* () {
      expect(yield* decodeToolInput('{"repoName": "facebook/react"}')).toEqual({
        repoName: 'facebook/react',
      })
      expect(yield* decodeToolInput('[1, "two"]')).toEqual([1, 'two'])
    }),
  )

  it.effect('keeps an object, and text that is not a JSON object, exactly as sent', () =>
    Effect.gen(function* () {
      expect(yield* decodeToolInput({ repoName: 'facebook/react' })).toEqual({
        repoName: 'facebook/react',
      })
      expect(yield* decodeToolInput('facebook/react')).toBe('facebook/react')
      expect(yield* decodeToolInput('42')).toBe('42')
    }),
  )
})

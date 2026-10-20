import { describe, expect, it } from '@effect/vitest'
import {
  AddIntegrationOutcome,
  MakeIntegrationOutcome,
  ApprovalId,
  Connection,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  ConnectionAuthorization,
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
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
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
    }),
  )
  return { requests, rpc, tools: connectionTools(toolRunner(scope)) }
})

/** The Flue tool must call the new RPC, keep diagnostics, and stop for the existing secure card. */
describe('make_integration', () => {
  const connection = Connection.make({
    id: ConnectionId.make('MARK-made-connection'),
    service: ServiceId.make('made:Morning'),
    serviceName: 'Morning',
    mark: null,
    name: null,
    identity: null,
    account: 'Morning',
    origin: 'Catalogue',
    ownership: ConnectionOwnership.cases.Personal.make({
      owner: { id: PersonId.make('MARK-person'), name: 'Ada', image: null },
    }),
    state: ConnectionState.cases.NeedsAuthorization.make({}),
    createdAt: 1,
  })
  for (const [outcome, expected] of [
    [
      MakeIntegrationOutcome.cases.Made.make({ account: 'Morning' }),
      {
        output: { ok: true, account: 'Morning', message: 'Made. It is ready as Morning.' },
        terminate: false,
      },
    ],
    [
      MakeIntegrationOutcome.cases.BuildFailed.make({ message: 'index.ts: invalid source' }),
      {
        output: { ok: false, message: 'The build failed: index.ts: invalid source' },
        terminate: false,
      },
    ],
    [
      MakeIntegrationOutcome.cases.AlreadyConnected.make({ account: 'Morning', name: 'Morning' }),
      {
        output: {
          ok: false,
          account: 'Morning',
          message:
            'An Integration called Morning already exists and was not changed. To do something different, make a new one under a new name.',
        },
        terminate: false,
      },
    ],
    [
      MakeIntegrationOutcome.cases.PendingAuthorization.make({
        account: 'Morning',
        step: ConnectionStep.cases.EnterKey.make({
          connection,
          fields: [{ name: 'token', label: 'API key' }],
        }),
      }),
      {
        output: {
          kind: 'connection-request',
          authorization: ConnectionAuthorization.cases.EnterKey.make({
            connectionId: connection.id,
            fields: [{ name: 'token', label: 'API key' }],
          }),
        },
        terminate: true,
      },
    ],
    [
      MakeIntegrationOutcome.cases.PendingAuthorization.make({
        account: 'Morning',
        step: ConnectionStep.cases.OpenSignIn.make({
          connection,
          address: 'https://example.test/sign-in',
        }),
      }),
      {
        output: {
          kind: 'connection-request',
          authorization: ConnectionAuthorization.cases.OpenSignIn.make({
            connectionId: connection.id,
          }),
        },
        terminate: true,
      },
    ],
  ] as const) {
    it.effect(`projects ${outcome._tag} ${'step' in outcome ? outcome.step._tag : ''}`, () =>
      Effect.gen(function* () {
        const { requests, rpc, tools } = yield* fixture()
        const [, , , , , , tool] = tools
        const files = [{ path: 'index.ts', content: 'export default {}' }]
        const call = yield* Effect.promise(() =>
          Promise.resolve(
            tool.run({
              data: { summary: 'Make morning check', name: 'Morning', files },
              signal: new AbortController().signal,
              toolCallId: 'MARK-call',
              log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
            }),
          ),
        ).pipe(Effect.forkScoped)
        const request = yield* Queue.take(requests)
        if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected RPC request')
        expect(request.tag).toBe('MakeIntegration')
        expect(request.payload).toEqual({ name: 'Morning', files })
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- RPC protocol envelopes have no schema constructor.
          _tag: 'Exit',
          clientId: 0,
          requestId: request.id,
          exit: Exit.succeed(outcome),
        })
        const result = yield* Fiber.join(call)
        expect(result).toMatchObject(expected)
        expect(JSON.stringify(result)).not.toContain('MARK-person')
        expect(JSON.stringify(result)).not.toContain('MARK-thread')
        expect(JSON.stringify(result)).not.toContain('https://example.test/sign-in')
        if (!MakeIntegrationOutcome.guards.PendingAuthorization(outcome))
          expect(JSON.stringify(result)).not.toContain('MARK-')
      }).pipe(Effect.scoped),
    )
  }
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
      expect(discovery.payload).toEqual({ query: 'Mail', limit: 25 })
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelopes have no schema constructor.
        _tag: 'Exit',
        clientId: 0,
        requestId: discovery.id,
        exit: Exit.succeed({
          tools: [],
          connected: [],
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
      expect(offer.payload).toEqual({
        service: 'mail',
        reason: 'Read your latest mail',
        wanted: 'Service',
      })
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
  /** Drives `connect` for a service the Person already has an account on. */
  const connectHeld = Effect.fn('ConnectionToolsTest.connectHeld')(function* (another: boolean) {
    const { requests, rpc, tools } = yield* fixture()
    const [, , connect] = tools
    const asked = {
      summary: 'Ask for the work Mail account',
      service: 'Mail',
      reason: 'To send it from your work address',
    }
    const call = yield* Effect.promise(() =>
      Promise.resolve(
        connect.run({
          data: another ? { ...asked, another: true } : asked,
          signal: new AbortController().signal,
          toolCallId: 'MARK-call',
          log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
        }),
      ),
    ).pipe(Effect.forkScoped)
    const discovery = yield* Queue.take(requests)
    if (!Predicate.isTagged(discovery, 'Request')) expect.fail('Expected discovery')
    expect(discovery.tag).toBe('FindTools')
    expect(discovery.payload).toEqual({ query: 'Mail', limit: 25 })
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelopes have no schema constructor.
      _tag: 'Exit',
      clientId: 0,
      requestId: discovery.id,
      exit: Exit.succeed({
        tools: [],
        unconnected: [],
        connected: [
          {
            id: ServiceId.make('mail'),
            name: 'Mail',
            description: 'Your mail',
            mark: null,
            authorization: ServiceAuthorization.cases.SignIn.make({}),
          },
        ],
      }),
    })
    return { requests, rpc, call }
  })

  it.effect('asks for one more account on a service that is already connected', () =>
    Effect.gen(function* () {
      const { requests, rpc, call } = yield* connectHeld(true)
      const offer = yield* Queue.take(requests)
      if (!Predicate.isTagged(offer, 'Request')) expect.fail('Expected offer')
      expect(offer.tag).toBe('OfferConnection')
      // The server is told this is a request for one more account, not for the service.
      expect(offer.payload).toEqual({
        service: 'mail',
        wanted: 'Another',
        reason: 'To send it from your work address',
      })
      yield* rpc.write({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelopes have no schema constructor.
        _tag: 'Exit',
        clientId: 0,
        requestId: offer.id,
        exit: Exit.succeed({
          kind: 'connection-request',
          service: ServiceId.make('mail'),
          serviceName: 'Mail',
          reason: 'To send it from your work address',
          ready: false,
          another: { askedAt: 1_000 },
        }),
      })
      // The card keeps when Vivid asked, so it is not settled by the account already there, and
      // the turn ends to wait for the Person.
      expect(yield* Fiber.join(call)).toMatchObject({
        terminate: true,
        output: { kind: 'connection-request', ready: false, another: { askedAt: 1_000 } },
      })
    }).pipe(Effect.scoped),
  )

  it.effect('shows no card for a connected service unless one more account was asked for', () =>
    Effect.gen(function* () {
      const { requests, call } = yield* connectHeld(false)
      const result = yield* Fiber.join(call)
      // No card, no end of turn: the model is told to use an account or to ask for another.
      expect(result).toMatchObject({ output: { connected: true } })
      expect(result).not.toHaveProperty('terminate', true)
      expect(JSON.stringify(result)).toContain('another set to true')
      // Nothing was offered: the server was asked only what is connected.
      expect(Option.isNone(yield* Queue.poll(requests))).toBe(true)
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
        expect(request.tag).toBe('AddIntegration')
        expect(request.payload).toEqual({
          address: 'https://records.example/mcp',
          name: 'Work Records',
          shared: false,
        })
        const connection = Connection.make({
          id: ConnectionId.make('MARK-connection'),
          service: ServiceId.make('MARK-service'),
          serviceName: 'Records',
          mark: null,
          name: 'Work Records',
          identity: null,
          account: 'Records (Work Records)',
          origin: 'Catalogue',
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
      expect(result).toMatchObject({
        terminate: true,
        output: {
          kind: 'approval-request',
          approvalId: 'MARK-approval',
          summary: 'Test Work Records',
        },
      })
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
        expect(execute.payload).toEqual({
          connectionId: 'MARK-connection',
          tool: 'get_message',
          input: { id: 'provider-message' },
          summary: 'Read mail',
          rationale: 'Answer the question',
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

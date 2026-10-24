import * as NodeCrypto from 'node:crypto'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type Context as ModelContext,
} from '@earendil-works/pi-ai'
import { init, useModel, useSandbox } from '@flue/runtime'
import { start } from '@flue/runtime/node'
import * as NodeBuffer from 'node:buffer'
import * as NodeZlib from 'node:zlib'
import { describe, expect, it } from '@effect/vitest'
import { DesktopAction, DesktopOutcome, PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { browseModelTool, computerSandboxFactory, desktopModelTool } from './computer.ts'
import { personComputerModelTool } from './windows.ts'
import { Scope, scopedRunner, toolRunner } from './scope.ts'
import { disposableStorage, testDatabaseConfigured } from '../../tests/schema.ts'

/** Valid PNG with a large ancillary text chunk proves image bytes bypass the text budget. */
const largePicture = () => {
  const png = NodeBuffer.Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9f8AAAAASUVORK5CYII=',
    'base64',
  )
  const data = NodeBuffer.Buffer.from('fixture\0' + 'A'.repeat(16000))
  const type = NodeBuffer.Buffer.from('tEXt')
  const length = NodeBuffer.Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = NodeBuffer.Buffer.alloc(4)
  crc.writeUInt32BE(NodeZlib.crc32(NodeBuffer.Buffer.concat([type, data])))
  return NodeBuffer.Buffer.concat([
    png.subarray(0, 33),
    length,
    type,
    data,
    crc,
    png.subarray(33),
  ]).toString('base64')
}

/** Real RPC client, Scope and settle; only the server response is deliberate fixture data. */
const fixture = Effect.fn('DesktopToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
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
    }),
  )
  const runTool = toolRunner(scope)
  return {
    requests,
    rpc,
    browser: browseModelTool(runTool),
    person: personComputerModelTool(runTool),
    tool: desktopModelTool(runTool),
    factory: computerSandboxFactory(runTool, scopedRunner(scope)),
  }
})

/** RPC SDK exit envelopes lack constructors in rc.116. This helper is the transport adapter. */
const reply = Effect.fn('DesktopToolsTest.reply')(function* (
  transport: Effect.Success<ReturnType<typeof fixture>>,
  outcome: DesktopOutcome,
) {
  const request = yield* Queue.take(transport.requests)
  if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected a generated RPC request')
  expect(request.tag).toBe('UseDesktop')
  expect(request.payload).toEqual({
    action: DesktopAction.cases.Look.make({}),
    summary: 'Look at the desktop',
  })
  yield* transport.rpc.write({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelope has no constructor in rc.116.
    _tag: 'Exit',
    clientId: 0,
    requestId: request.id,
    exit: Exit.succeed(outcome),
  })
})

/** Build a public pi stream with a tool call or a final answer; no credentials or HTTP are involved. */
function modelReply(model: Model<Api>, request: boolean) {
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 0,
    stopReason: request ? 'toolUse' : 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: request
      ? [
          {
            type: 'toolCall',
            id: 'fixture-call',
            name: 'use_desktop',
            arguments: {
              action: DesktopAction.cases.Look.make({}),
              summary: 'Look at the desktop',
            },
          },
        ]
      : [{ type: 'text', text: 'The model received the picture.' }],
  }
  const stream = createAssistantMessageEventStream()
  stream.push({ type: 'start', partial: Object.assign({}, message, { content: [] }) })
  for (const block of message.content) {
    if (block.type === 'toolCall') {
      stream.push({
        type: 'toolcall_start',
        contentIndex: 0,
        partial: Object.assign({}, message, {
          content: [Object.assign({}, block, { arguments: {} })],
        }),
      })
      stream.push({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: JSON.stringify(block.arguments),
        partial: message,
      })
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message })
    }
    if (block.type === 'text') {
      stream.push({
        type: 'text_start',
        contentIndex: 0,
        partial: Object.assign({}, message, { content: [{ type: 'text', text: '' }] }),
      })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: block.text, partial: message })
      stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: message })
    }
  }
  stream.push({ type: 'done', reason: request ? 'toolUse' : 'stop', message })
  return stream
}

describe.skipIf(!testDatabaseConfigured)('Flue desktop picture to model', () => {
  it.live(
    'gives the model the machine tools and pictures, and starting a conversation asks the Computer nothing',
    () =>
      Effect.gen(function* () {
        const transport = yield* fixture()
        const { storage: db } = yield* disposableStorage
        const picture = largePicture()
        const builtIn = openrouterProvider()
        const model = builtIn.getModels().find((candidate) => candidate.input.includes('image'))
        if (model === undefined) expect.fail('The installed catalog needs a vision model')
        const modelAddress = `openrouter/${model.id}`
        let calls = 0
        let received = false
        let declared = ''
        const provider = {
          ...builtIn,
          auth: {
            apiKey: {
              name: 'Controlled desktop test model',
              resolve: () => Promise.resolve({ auth: {} }),
            },
          },
          streamSimple: (chosen: Model<Api>, context: ModelContext) => {
            calls += 1
            // Flue declares the callable tools to the model on the transcript's system
            // messages (pi-agent-core agent-loop, `toolsAdded`); the first request has them all.
            if (calls === 1) declared = JSON.stringify(context.messages)
            if (calls > 1)
              received = context.messages.some(
                (message) =>
                  message.role === 'toolResult' &&
                  message.content.some(
                    (block) =>
                      block.type === 'image' &&
                      block.mimeType === 'image/png' &&
                      block.data === picture,
                  ),
              )
            return modelReply(chosen, calls === 1)
          },
        }
        /** The same public factory the production Computer tools mount; no SDK internals are replaced. */
        function DesktopImageTest() {
          useModel(modelAddress)
          useSandbox(transport.factory)
          return 'Use the desktop tool and then answer.'
        }
        DesktopImageTest.agentName = 'desktop-image-test'
        DesktopImageTest.durability = { maxAttempts: 1 }
        yield* Effect.acquireRelease(
          Effect.tryPromise(() => start({ agents: [DesktopImageTest], providers: [provider], db })),
          (runtime) => Effect.promise(() => runtime.stop()),
        )
        const handle = init(DesktopImageTest, { id: NodeCrypto.randomUUID() })
        const receipt = yield* Effect.tryPromise(() => handle.dispatch('Look at the desktop'))
        yield* Effect.all(
          [
            Effect.tryPromise(() => handle.read(receipt)),
            reply(
              transport,
              DesktopOutcome.cases.Completed.make({
                view: {
                  picture,
                  width: 1,
                  height: 1,
                  pointer: { x: 0, y: 0 },
                  window: 'Fixture window',
                },
              }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(calls).toBe(2)
        expect(received).toBe(true)
        // Flue's own six on the real Computer, beside the tools that return pictures.
        for (const tool of [
          'read',
          'write',
          'edit',
          'bash',
          'grep',
          'glob',
          'use_desktop',
          'browse',
        ])
          expect(declared).toContain(`"name":"${tool}"`)
        // The one request the server saw was the desktop step, answered above. Flue looked for a
        // workspace when the conversation started (AGENTS.md, skills, a directory listing) and
        // none of that became a call: a sleeping Computer is not woken by a conversation.
        expect(yield* Queue.size(transport.requests)).toBe(0)
      }).pipe(Effect.scoped),
  )
})

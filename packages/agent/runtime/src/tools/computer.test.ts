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
import { testDatabaseConfigured } from '../../../../../apps/server/src/database/testdb.ts'
import * as NodeBuffer from 'node:buffer'
import * as NodeZlib from 'node:zlib'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { describe, expect, it } from '@effect/vitest'
import {
  BrowseTarget,
  BrowserAction,
  BrowseOutcome,
  BrowseResult,
  BrowserPicture,
  DesktopAction,
  DesktopOutcome,
  PersonId,
  ThreadId,
  ApprovalId,
  WindowAction,
  WindowResult,
  WindowOutcome,
  WindowId,
  AppId,
  LookId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { browseModelTool, computerSandboxFactory, desktopModelTool } from './computer.ts'
import { personComputerModelTool } from './windows.ts'
import { Scope, scopedRunner, toolRunner } from './scope.ts'
import { disposableStorage } from '../../tests/schema.ts'

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
      folder: Option.none(),
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

/** Real RPC receipts prove target selection and every model outcome without replacing the client. */
const browserReply = Effect.fn('BrowserToolsTest.reply')(function* (
  transport: Effect.Success<ReturnType<typeof fixture>>,
  outcome: BrowseOutcome,
  target: BrowseTarget,
) {
  const request = yield* Queue.take(transport.requests)
  if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected a generated RPC request')
  expect(request.tag).toBe('Browse')
  expect(request.payload).toEqual({
    target,
    action: BrowserAction.cases.Screenshot.make({}),
    summary: 'Look at my page',
  })
  yield* transport.rpc.write({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK exit envelopes have no constructor in rc.116.
    _tag: 'Exit',
    clientId: 0,
    requestId: request.id,
    exit: Exit.succeed(outcome),
  })
})
const browserPage = BrowseResult.make({
  address: 'https://example.test',
  title: 'My page',
  outline: 'Account',
  truncated: false,
  tabs: [],
})

describe('browser model target and image result', () => {
  it.effect('rejects unknown computers and overlong controls before any RPC dispatch', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      const invalid: Schema.JsonObject[] = [
        { computer: 'other', action: { kind: 'read' }, summary: 'Read the page' },
        { action: { kind: 'read' }, summary: '   ' },
        { action: { kind: 'show_tab', tab: 0 }, summary: 'Show the tab' },
        { action: { kind: 'close_tab', tab: 51 }, summary: 'Close the tab' },
        { action: { kind: 'wait', seconds: 11 }, summary: 'Wait for the page' },
        { action: { kind: 'click', target: 'x'.repeat(4001) }, summary: 'Click the control' },
        { action: { kind: 'press', key: 'x'.repeat(201) }, summary: 'Press the key' },
      ]
      for (const input of invalid) {
        expect(() =>
          validateToolArguments(transport.browser, {
            type: 'toolCall',
            id: 'invalid-browse',
            name: 'browse',
            arguments: input,
          }),
        ).toThrow('Validation failed')
        const result = yield* Effect.promise(() =>
          transport.browser.execute('invalid-browse', input, new AbortController().signal),
        )
        expect(JSON.stringify(result.content)).toContain('The browser request is invalid.')
      }
      expect(yield* Queue.size(transport.requests)).toBe(0)
    }).pipe(Effect.scoped),
  )

  for (const choice of [undefined, 'vivid', 'person'] as const) {
    it.effect(
      `selects ${choice === undefined ? 'Vivid by default' : choice} only from the computer word`,
      () =>
        Effect.gen(function* () {
          const transport = yield* fixture()
          const input: Schema.JsonObject =
            choice === undefined
              ? { action: { kind: 'screenshot' }, summary: 'Look at my page' }
              : { action: { kind: 'screenshot' }, summary: 'Look at my page', computer: choice }
          expect(
            validateToolArguments(transport.browser, {
              type: 'toolCall',
              id: 'browse-call',
              name: 'browse',
              arguments: input,
            }),
          ).toEqual(input)
          const call = Effect.promise(() =>
            transport.browser.execute('browse-call', input, new AbortController().signal),
          )
          const response = browserReply(
            transport,
            BrowseOutcome.cases.Completed.make({ result: browserPage }),
            choice === 'person'
              ? BrowseTarget.cases.Person.make({})
              : BrowseTarget.cases.Vivid.make({}),
          )
          const [result] = yield* Effect.all([call, response], { concurrency: 2 })
          expect(result.content.every((block) => block.type === 'text')).toBe(true)
          expect(JSON.stringify(result.details)).toContain('The browser action completed.')
          if (choice === 'person') expect(result.details).not.toHaveProperty('computer')
          else expect(result.details).toHaveProperty('computer.active', true)
        }).pipe(Effect.scoped),
    )
  }
  it.effect('keeps the full screenshot in Flue image content and out of bounded text', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      const picture = largePicture()
      const call = Effect.promise(() =>
        transport.browser.execute(
          'browse-call',
          { action: { kind: 'screenshot' }, summary: 'Look at my page', computer: 'person' },
          new AbortController().signal,
        ),
      )
      const response = browserReply(
        transport,
        BrowseOutcome.cases.Completed.make({
          result: BrowseResult.make({
            ...browserPage,
            picture: BrowserPicture.make(picture),
          }),
        }),
        BrowseTarget.cases.Person.make({}),
      )
      const [result] = yield* Effect.all([call, response], { concurrency: 2 })
      expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: picture })
      expect(JSON.stringify(result.details)).not.toContain(picture)
    }).pipe(Effect.scoped),
  )
  for (const outcome of [
    BrowseOutcome.cases.NotConnected.make({}),
    BrowseOutcome.cases.NotAllowed.make({}),
    BrowseOutcome.cases.AddressRefused.make({}),
    BrowseOutcome.cases.Busy.make({}),
    BrowseOutcome.cases.Stopped.make({}),
    BrowseOutcome.cases.PageGone.make({}),
    BrowseOutcome.cases.Unsupported.make({}),
    BrowseOutcome.cases.RunRequired.make({}),
    BrowseOutcome.cases.OutcomeUnknown.make({}),
    BrowseOutcome.cases.Unavailable.make({
      reason: 'The Person’s computer could not complete this action.',
    }),
    BrowseOutcome.cases.Blocked.make({ rule: 'Never submit' }),
    BrowseOutcome.cases.ApprovalRequired.make({
      approvalId: ApprovalId.make('fixture-approval'),
      summary: 'Click Send',
    }),
  ]) {
    it.effect(`renders ${outcome._tag} as readable text`, () =>
      Effect.gen(function* () {
        const transport = yield* fixture()
        const call = Effect.promise(() =>
          transport.browser.execute(
            'browse-call',
            { action: { kind: 'screenshot' }, summary: 'Look at my page', computer: 'person' },
            new AbortController().signal,
          ),
        )
        const [result] = yield* Effect.all(
          [call, browserReply(transport, outcome, BrowseTarget.cases.Person.make({}))],
          { concurrency: 2 },
        )
        expect(result.content.every((block) => block.type === 'text')).toBe(true)
        const [text] = result.content
        if (text === undefined || text.type !== 'text') expect.fail('Expected readable outcome')
        expect(text.text).toContain('message')
        if (BrowseOutcome.guards.Stopped(outcome)) {
          expect(text.text).toContain('do not retry by yourself')
          expect(result.terminate).toBe(true)
        }
      }).pipe(Effect.scoped),
    )
  }
})

describe('desktop model image result', () => {
  it.effect('uses a complete public tool schema that pi validates before native execution', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      const input = {
        action: DesktopAction.cases.Move.make({ to: { x: 8, y: 9 } }),
        summary: 'Move the pointer',
      }
      expect(
        validateToolArguments(transport.tool, {
          type: 'toolCall',
          id: 'fixture-call',
          name: 'use_desktop',
          arguments: input,
        }),
      ).toEqual(input)
      expect(() =>
        validateToolArguments(transport.tool, {
          type: 'toolCall',
          id: 'fixture-call',
          name: 'use_desktop',
          arguments: {
            // Deliberately invalid wire input exercises pi's public ingress validator.
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Deliberately invalid RPC wire fixture cannot be constructed by the domain schema.
            action: { _tag: 'Move', to: { x: -1, y: 0 } },
            summary: 'Invalid pointer',
          },
        }),
      ).toThrow('Validation failed')
    }).pipe(Effect.scoped),
  )

  it.effect(
    'carries the full PNG in image content, with no base64 or identifiers in bounded text',
    () =>
      Effect.gen(function* () {
        const transport = yield* fixture()
        // Longer than settle's text limit: image content must remain intact.
        const picture = largePicture()
        const call = Effect.promise(() =>
          transport.tool.execute(
            'fixture-call',
            {
              action: DesktopAction.cases.Look.make({}),
              summary: 'Look at the desktop',
            },
            new AbortController().signal,
          ),
        )
        const response = reply(
          transport,
          DesktopOutcome.cases.Completed.make({
            view: {
              picture,
              width: 1,
              height: 1,
              pointer: { x: 0, y: 0 },
              window: 'Invoice',
            },
          }),
        )
        const [result] = yield* Effect.all([call, response], { concurrency: 2 })
        const image = result.content.find((block) => block.type === 'image')
        expect(image !== undefined && 'data' in image && image.data === picture).toBe(true)
        const text = result.content.find((block) => block.type === 'text')
        expect(text !== undefined && 'text' in text && text.text.includes('Invoice')).toBe(true)
        expect(JSON.stringify(result.details)).not.toContain(picture)
        expect(JSON.stringify(result.details)).not.toContain('fixture-')
      }).pipe(Effect.scoped),
  )

  it.effect('approval terminates the turn and carries no image', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      const call = Effect.promise(() =>
        transport.tool.execute(
          'fixture-call',
          {
            action: DesktopAction.cases.Look.make({}),
            summary: 'Look at the desktop',
          },
          new AbortController().signal,
        ),
      )
      const response = reply(
        transport,
        DesktopOutcome.cases.ApprovalRequired.make({
          approvalId: ApprovalId.make('fixture-approval'),
          summary: 'Approval fixture',
        }),
      )
      const [result] = yield* Effect.all([call, response], { concurrency: 2 })
      expect(result.terminate).toBe(true)
      expect(result.content.every((block) => block.type === 'text')).toBe(true)
    }).pipe(Effect.scoped),
  )
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
        for (const tool of ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'use_desktop', 'browse'])
          expect(declared).toContain(`"name":"${tool}"`)
        // The one request the server saw was the desktop step, answered above. Flue looked for a
        // workspace when the conversation started (AGENTS.md, skills, a directory listing) and
        // none of that became a call: a sleeping Computer is not woken by a conversation.
        expect(yield* Queue.size(transport.requests)).toBe(0)
      }).pipe(Effect.scoped),
    15000,
  )
})

const nativeWindow = WindowId.make('native-window')
const nativeLook = LookId.make('native-look')
const nativeView = {
  window: nativeWindow,
  app: 'Terminal',
  look: nativeLook,
  picture: largePicture(),
  width: 1,
  height: 1,
  outline: '[1] Edit command',
  truncated: false,
}

/** Real schema-derived RPC and tool runner verify native translation and model image receipts. */
const nativeReply = Effect.fn('PersonComputerTest.reply')(function* (
  transport: Effect.Success<ReturnType<typeof fixture>>,
  expected: WindowAction,
  outcome: WindowOutcome,
) {
  const request = yield* Queue.take(transport.requests)
  if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected a generated RPC request')
  expect(request.tag).toBe('UseWindow')
  expect(request.payload).toEqual({ action: expected, summary: 'Work in the window' })
  yield* transport.rpc.write({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- rc.116 RPC SDK exit envelopes have no constructor.
    _tag: 'Exit',
    clientId: 0,
    requestId: request.id,
    exit: Exit.succeed(outcome),
  })
})

const nativeActions: ReadonlyArray<{ input: Schema.JsonObject; action: WindowAction }> = [
  { input: { kind: 'list_apps' }, action: WindowAction.cases.ListApps.make({}) },
  { input: { kind: 'list_windows' }, action: WindowAction.cases.ListWindows.make({}) },
  {
    input: { kind: 'open', app: 'terminal' },
    action: WindowAction.cases.Open.make({ app: AppId.make('terminal') }),
  },
  {
    input: { kind: 'look', window: nativeWindow },
    action: WindowAction.cases.Look.make({ window: nativeWindow }),
  },
  {
    input: { kind: 'press', window: nativeWindow, look: nativeLook, element: 1 },
    action: WindowAction.cases.Press.make({ window: nativeWindow, look: nativeLook, element: 1 }),
  },
  {
    input: { kind: 'choose', window: nativeWindow, look: nativeLook, element: 1 },
    action: WindowAction.cases.Choose.make({ window: nativeWindow, look: nativeLook, element: 1 }),
  },
  {
    input: { kind: 'fill', window: nativeWindow, look: nativeLook, element: 1, text: 'command' },
    action: WindowAction.cases.Fill.make({
      window: nativeWindow,
      look: nativeLook,
      element: 1,
      text: 'command',
    }),
  },
  {
    input: {
      kind: 'click',
      window: nativeWindow,
      look: nativeLook,
      x: 2,
      y: 3,
      button: 'right',
      times: 2,
    },
    action: WindowAction.cases.Click.make({
      window: nativeWindow,
      look: nativeLook,
      at: { x: 2, y: 3 },
      button: 'right',
      times: 2,
    }),
  },
  {
    input: { kind: 'type', window: nativeWindow, text: 'command' },
    action: WindowAction.cases.Type.make({ window: nativeWindow, text: 'command' }),
  },
  {
    input: { kind: 'keys', window: nativeWindow, keys: 'Enter' },
    action: WindowAction.cases.Keys.make({ window: nativeWindow, keys: 'Enter' }),
  },
  {
    input: {
      kind: 'scroll',
      window: nativeWindow,
      look: nativeLook,
      x: 2,
      y: 3,
      direction: 'down',
      notches: 2,
    },
    action: WindowAction.cases.Scroll.make({
      window: nativeWindow,
      look: nativeLook,
      at: { x: 2, y: 3 },
      direction: 'down',
      notches: 2,
    }),
  },
  {
    input: { kind: 'close', window: nativeWindow },
    action: WindowAction.cases.Close.make({ window: nativeWindow }),
  },
]

describe('use_person_computer', () => {
  for (const step of nativeActions) {
    it.effect(`maps ${step.action._tag} to the native contract`, () =>
      Effect.gen(function* () {
        const transport = yield* fixture()
        const input = { summary: 'Work in the window', action: step.input }
        expect(
          validateToolArguments(transport.person, {
            type: 'toolCall',
            id: 'native',
            name: 'use_person_computer',
            arguments: input,
          }),
        ).toEqual(input)
        const [result] = yield* Effect.all(
          [
            Effect.promise(() => transport.person.execute('native', input)),
            nativeReply(
              transport,
              step.action,
              WindowOutcome.cases.Completed.make({ result: WindowResult.cases.Closed.make({}) }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(result.details).toMatchObject({ ok: true })
        expect(result.details).not.toHaveProperty('computer')
      }).pipe(Effect.scoped),
    )
  }

  it.effect('requires a meaningful shared summary before any RPC', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      for (const input of [
        { action: { kind: 'list_apps' } },
        { action: { kind: 'list_apps' }, summary: '  ' },
      ]) {
        const result = yield* Effect.promise(() => transport.person.execute('invalid', input))
        expect(result.details).toMatchObject({ ok: false })
      }
      expect(yield* Queue.size(transport.requests)).toBe(0)
    }).pipe(Effect.scoped),
  )

  for (const result of [
    WindowResult.cases.Seen.make({ view: nativeView }),
    WindowResult.cases.Typed.make({ view: nativeView, complete: false, sent: 3 }),
    WindowResult.cases.Closing.make({ view: nativeView }),
  ]) {
    it.effect(`${result._tag} hands the full PNG to Flue with outline and look ID as text`, () =>
      Effect.gen(function* () {
        const transport = yield* fixture()
        const [receipt] = yield* Effect.all(
          [
            Effect.promise(() =>
              transport.person.execute('native', {
                summary: 'Work in the window',
                action: { kind: 'look', window: nativeWindow },
              }),
            ),
            nativeReply(
              transport,
              WindowAction.cases.Look.make({ window: nativeWindow }),
              WindowOutcome.cases.Completed.make({ result }),
            ),
          ],
          { concurrency: 2 },
        )
        expect(receipt.content).toContainEqual({
          type: 'image',
          mimeType: 'image/png',
          data: nativeView.picture,
        })
        expect(receipt.details).toMatchObject({
          view: { look: nativeLook, outline: nativeView.outline },
        })
        expect(receipt.details).not.toHaveProperty('computer')
        expect(JSON.stringify(receipt.details)).not.toContain(nativeView.picture)
      }).pipe(Effect.scoped),
    )
  }

  it.effect('Stopped terminates the model turn', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      const [receipt] = yield* Effect.all(
        [
          Effect.promise(() =>
            transport.person.execute('native', {
              summary: 'Work in the window',
              action: { kind: 'look', window: nativeWindow },
            }),
          ),
          nativeReply(
            transport,
            WindowAction.cases.Look.make({ window: nativeWindow }),
            WindowOutcome.cases.Refused.make({ reason: 'Stopped' }),
          ),
        ],
        { concurrency: 2 },
      )
      expect(receipt.terminate).toBe(true)
      expect(receipt.details).toMatchObject({
        message: 'The person stopped Vivid on their computer. Stop and do not retry.',
      })
    }).pipe(Effect.scoped),
  )
})

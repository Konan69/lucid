import { validateToolArguments } from '@earendil-works/pi-ai'
import {
  BrowseOutcome,
  BrowseTarget,
  BrowseResult,
  BrowserAction,
  BrowserPicture,
  ApprovalId,
  WindowId,
  LookId,
  WindowAction,
  WindowOutcome,
  WindowResult,
  AppId,
} from '@vivid/contracts'
import * as NodeBuffer from 'node:buffer'
import * as NodeZlib from 'node:zlib'
import { describe, expect, it } from '@effect/vitest'
import { DesktopAction, DesktopOutcome, PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Predicate, Queue, Result, Schema } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { browseModelTool, desktopModelTool } from './computer.ts'
import { personComputerModelTool } from './windows.ts'
import { Scope, toolRunner } from './scope.ts'
import { nativeTool } from './tests/harness.ts'

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
      timezone: '',
    }),
  )
  const runTool = toolRunner(scope)
  return {
    requests,
    rpc,
    browser: nativeTool(browseModelTool(runTool)),
    person: nativeTool(personComputerModelTool(runTool)),
    tool: nativeTool(desktopModelTool(runTool)),
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
        const validation = Result.try(() =>
          validateToolArguments(transport.browser, {
            type: 'toolCall',
            id: 'invalid-browse',
            name: 'browse',
            arguments: input,
          }),
        )
        if (!Result.isFailure(validation) || !(validation.failure instanceof Error))
          expect.fail('Expected a schema refusal.')
        expect(result.content).toEqual([
          { type: 'text', text: `<harness>\n[error] ${validation.failure.message}\n</harness>` },
        ])
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
  it.effect('keeps the full screenshot in Pi image content and out of bounded text', () =>
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
  it.effect(
    'preserves each refusal, uncertainty and approval receipt through the real browser callback',
    () =>
      Effect.gen(function* () {
        const cases = [
          [
            BrowseOutcome.cases.NotConnected.make({}),
            {
              ok: false,
              message: expect.stringContaining('desktop app is not connected'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.NotAllowed.make({}),
            {
              ok: false,
              message: expect.stringContaining('has not allowed Vivid'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.AddressRefused.make({}),
            {
              ok: false,
              message: expect.stringContaining('address cannot be opened'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.Busy.make({}),
            {
              ok: false,
              message: expect.stringContaining('busy with an earlier action'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.Stopped.make({}),
            {
              ok: false,
              message: expect.stringContaining('Person took control'),
            },
            true,
          ],
          [
            BrowseOutcome.cases.PageGone.make({}),
            { ok: false, message: expect.stringContaining('page is gone') },
            false,
          ],
          [
            BrowseOutcome.cases.Unsupported.make({}),
            {
              ok: false,
              message: expect.stringContaining('does not support this browser action'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.RunRequired.make({}),
            {
              ok: false,
              message: expect.stringContaining('work that asked for it has ended'),
            },
            true,
          ],
          [
            BrowseOutcome.cases.OutcomeUnknown.make({}),
            {
              ok: false,
              message: expect.stringContaining('action may or may not have happened'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.Unavailable.make({
              reason: 'The Person’s computer could not complete this action.',
            }),
            {
              ok: false,
              reason: 'The Person’s computer could not complete this action.',
              message: expect.stringContaining('Computer is unavailable'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.Blocked.make({ rule: 'Never submit' }),
            {
              ok: false,
              rule: 'Never submit',
              message: expect.stringContaining('rule forbids this action'),
            },
            false,
          ],
          [
            BrowseOutcome.cases.ApprovalRequired.make({
              approvalId: ApprovalId.make('fixture-approval'),
              summary: 'Click Send',
            }),
            {
              kind: 'approval-request',
              approvalId: 'fixture-approval',
              summary: 'Click Send',
              message: expect.stringContaining('person has been asked to approve'),
            },
            true,
          ],
        ] as const
        for (const [outcome, expected, terminate] of cases) {
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
          expect(
            result.content.every((block) => block.type === 'text'),
            outcome._tag,
          ).toBe(true)
          expect(result.details, outcome._tag).toEqual(expected)
          expect(result.terminate, outcome._tag).toBe(terminate)
        }
      }).pipe(Effect.scoped),
  )
})

describe('desktop model image result', () => {
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
  it.effect('maps every native action input to the independent native wire contract', () =>
    Effect.gen(function* () {
      for (const step of nativeActions) {
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
      }
    }).pipe(Effect.scoped),
  )

  it.effect('requires a meaningful shared summary before any RPC', () =>
    Effect.gen(function* () {
      const transport = yield* fixture()
      const invalid: Schema.JsonObject[] = [
        { action: { kind: 'list_apps' } },
        { action: { kind: 'list_apps' }, summary: '  ' },
      ]
      for (const input of invalid) {
        const result = yield* Effect.promise(() => transport.person.execute('invalid', input))
        expect(result.isError).toBe(true)
        const validation = Result.try(() =>
          validateToolArguments(transport.person, {
            type: 'toolCall',
            id: 'invalid',
            name: 'use_person_computer',
            arguments: input,
          }),
        )
        if (!Result.isFailure(validation) || !(validation.failure instanceof Error))
          expect.fail('Expected a schema refusal.')
        expect(result.content).toEqual([
          { type: 'text', text: `<harness>\n[error] ${validation.failure.message}\n</harness>` },
        ])
      }
      expect(yield* Queue.size(transport.requests)).toBe(0)
    }).pipe(Effect.scoped),
  )

  for (const result of [
    WindowResult.cases.Seen.make({ view: nativeView }),
    WindowResult.cases.Typed.make({ view: nativeView, complete: false, sent: 3 }),
    WindowResult.cases.Closing.make({ view: nativeView }),
  ]) {
    it.effect(`${result._tag} hands the full PNG to Pi with outline and look ID as text`, () =>
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

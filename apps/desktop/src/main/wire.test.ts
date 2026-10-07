import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import {
  Framed,
  ComputerCall,
  ComputerLine,
  ComputerReply,
  changes,
  decodeLine,
  lineFramer,
  requestLine,
  screenshotPng,
} from './wire.ts'

const window = { app: 'notepad', id: '7' }
/** A written line read back as plain JSON, to compare with the Computer's documented shape. */
const written = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const lines = (found: ReadonlyArray<Framed>) =>
  found.map((framed) => (Framed.guards.Line(framed) ? framed.text : 'TOO LONG'))

describe('the Computer’s JSON lines', () => {
  it('cuts lines at any chunk boundary, keeping a character split across two chunks', () => {
    const frame = lineFramer(1024)
    const bytes = Buffer.from('{"a":"é"}\r\n{"b":2}\n{"c"', 'utf8')
    // The split falls inside the two bytes of "é".
    expect(lines(frame(bytes.subarray(0, 7)))).toEqual([])
    expect(lines(frame(bytes.subarray(7)))).toEqual(['{"a":"é"}', '{"b":2}'])
    expect(lines(frame(Buffer.from(':3}\n')))).toEqual(['{"c":3}'])
  })

  it('stops reading after a line longer than the limit', () => {
    const frame = lineFramer(8)
    expect(lines(frame(Buffer.from('123456789')))).toEqual(['TOO LONG'])
    expect(lines(frame(Buffer.from('\n{"id":1}\n')))).toEqual([])
  })

  it('decodes a reply, an approval ask, and a refusal message', () => {
    expect(decodeLine('{"id":4,"ok":true,"result":{"phase":"Idle"}}')).toEqual(
      Option.some(
        ComputerLine.cases.Reply.make({
          id: 4,
          reply: ComputerReply.cases.Answered.make({ result: { phase: 'Idle' } }),
        }),
      ),
    )
    // An approval ask is its own line kind: the desktop answers it itself, never the Person.
    expect(
      decodeLine(
        '{"id":5,"ok":false,"approvalRequest":{"app":"notepad.exe","displayName":"Notepad","allowPersistentApproval":true}}',
      ),
    ).toEqual(Option.some(ComputerLine.cases.Approval.make({ id: 5, app: 'notepad.exe' })))
    expect(
      decodeLine('{"id":6,"ok":false,"error":"computer-use request budget exhausted"}'),
    ).toEqual(
      Option.some(
        ComputerLine.cases.Reply.make({
          id: 6,
          reply: ComputerReply.cases.Refused.make({
            name: 'computer-use request budget exhausted',
            delivered: Option.none(),
            reason: Option.none(),
          }),
        }),
      ),
    )
  })

  it('a line that is not the protocol decodes to nothing', () => {
    expect(decodeLine('fake Computer started')).toEqual(Option.none())
    expect(decodeLine('{"id":"7","ok":true,"result":{}}')).toEqual(Option.none())
    expect(decodeLine('{"event":"started"}')).toEqual(Option.none())
  })

  it.effect('writes a request as the Computer’s methods take them', () =>
    Effect.gen(function* () {
      const click = yield* requestLine({
        id: 9,
        call: ComputerCall.cases.ClickPoint.make({
          window,
          x: 10,
          y: 20,
          look: 'look1',
          count: 2,
          button: 'right',
        }),
        turn: Option.some('run-1'),
        budget: 5000,
        approvedApp: Option.none(),
      })
      expect(written(click)).toEqual({
        id: 9,
        method: 'click',
        params: {
          window: { app: 'notepad', id: 7 },
          x: 10,
          y: 20,
          screenshotId: 'look1',
          click_count: 2,
          mouse_button: 'right',
        },
        meta: {
          'x-codex-turn-metadata': JSON.stringify({ session_id: 'run-1', turn_id: 'run-1' }),
          'x-oai-cua-request-budget-ms': 5000,
          'x-codex-browser-use-security-mode': 'disabled-for-local-testing',
        },
      })
      // A launch names the app by its inventory id.
      const launch = yield* requestLine({
        id: 2,
        call: ComputerCall.cases.LaunchApp.make({ app: 'Notepad', id: 'notepad.app' }),
        turn: Option.some('run-2'),
        budget: 15_000,
        approvedApp: Option.none(),
      })
      expect(written(launch)).toEqual({
        id: 2,
        method: 'launch_app',
        params: { app: 'notepad.app' },
        meta: {
          'x-codex-turn-metadata': JSON.stringify({ session_id: 'run-2', turn_id: 'run-2' }),
          'x-oai-cua-request-budget-ms': 15_000,
          'x-codex-browser-use-security-mode': 'disabled-for-local-testing',
        },
      })
      // A fill is `set_value`: the element's own way of taking text.
      const fill = yield* requestLine({
        id: 3,
        call: ComputerCall.cases.FillElement.make({ window, element: 4, text: 'hello' }),
        turn: Option.some('run-2'),
        budget: 10_000,
        approvedApp: Option.none(),
      })
      expect(written(fill)).toEqual({
        id: 3,
        method: 'set_value',
        params: { window: { app: 'notepad', id: 7 }, element_index: 4, value: 'hello' },
        meta: {
          'x-codex-turn-metadata': JSON.stringify({ session_id: 'run-2', turn_id: 'run-2' }),
          'x-oai-cua-request-budget-ms': 10_000,
          'x-codex-browser-use-security-mode': 'disabled-for-local-testing',
        },
      })
    }),
  )

  it.effect('begin turn and status stay local; the rest reach the wire', () =>
    Effect.gen(function* () {
      const local = (call: ComputerCall) =>
        requestLine({
          id: 1,
          call,
          turn: Option.none(),
          budget: 1000,
          approvedApp: Option.none(),
        }).pipe(Effect.option)
      expect(yield* local(ComputerCall.cases.BeginTurn.make({}))).toEqual(Option.some(''))
      expect(yield* local(ComputerCall.cases.Status.make({}))).toEqual(Option.some(''))
      const end = yield* requestLine({
        id: 8,
        call: ComputerCall.cases.EndTurn.make({}),
        turn: Option.some('run-1'),
        budget: 3000,
        approvedApp: Option.none(),
      })
      expect(written(end)).toEqual({
        id: 8,
        method: 'end_turn',
        params: {},
        meta: {
          'x-codex-turn-metadata': JSON.stringify({ session_id: 'run-1', turn_id: 'run-1' }),
          'x-oai-cua-request-budget-ms': 3000,
          'x-codex-browser-use-security-mode': 'disabled-for-local-testing',
        },
      })
    }),
  )

  it.effect('a picture arrives as a data URL or a path; anything else is not one', () =>
    Effect.gen(function* () {
      expect(yield* screenshotPng('data:image/png;base64,iVBORw0KGgo=')).toEqual(
        Option.some('iVBORw0KGgo='),
      )
      expect(yield* screenshotPng('notepad.png')).toEqual(Option.none())
      // On POSIX, a drive-prefixed directory is relative; on Windows the temp directory is
      // already a drive path. Both exercise the real file ingress without changing process cwd.
      const prefix =
        process.platform === 'win32'
          ? NodePath.join(NodeOS.tmpdir(), 'vivid-picture-')
          : 'C:\\vivid-picture-'
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(prefix)),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      )
      const path = NodePath.join(directory, 'picture.png')
      const picture = Buffer.from('iVBORw0KGgo=', 'base64')
      NodeFS.writeFileSync(path, picture)
      expect(yield* screenshotPng(path)).toEqual(Option.some(picture.toString('base64')))
      NodeFS.rmSync(path)
      expect(yield* screenshotPng(path)).toEqual(Option.none())
    }),
  )

  it('reads change nothing; input and a launch do', () => {
    expect(changes(ComputerCall.cases.WindowState.make({ window }))).toBe(false)
    expect(changes(ComputerCall.cases.ListApps.make({}))).toBe(false)
    expect(changes(ComputerCall.cases.TypeText.make({ window, text: 'a' }))).toBe(true)
    expect(changes(ComputerCall.cases.LaunchApp.make({ app: 'Notepad', id: 'x' }))).toBe(true)
  })
})

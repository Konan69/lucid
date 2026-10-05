import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  Framed,
  HelperCall,
  HelperLine,
  HelperReply,
  changes,
  decodeLine,
  lineFramer,
  requestLine,
} from './wire.ts'

const window = { app: 'notepad', id: 'session:1A' }
/** A written line read back as plain JSON, to compare with the helper's documented shape. */
const written = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const lines = (found: ReadonlyArray<Framed>) =>
  found.map((framed) => (Framed.guards.Line(framed) ? framed.text : 'TOO LONG'))

describe('the helper’s JSON lines', () => {
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

  it('decodes a reply, a refusal with what typing delivered, and the stop event', () => {
    expect(decodeLine('{"id":4,"ok":true,"result":{"active":true}}')).toEqual(
      Option.some(
        HelperLine.cases.Reply.make({
          id: 4,
          reply: HelperReply.cases.Answered.make({ result: { active: true } }),
        }),
      ),
    )
    expect(
      decodeLine(
        '{"id":5,"error":{"name":"TypingInterrupted","message":"m","delivered":3,"reason":"PersonStopped"}}',
      ),
    ).toEqual(
      Option.some(
        HelperLine.cases.Reply.make({
          id: 5,
          reply: HelperReply.cases.Refused.make({
            name: 'TypingInterrupted',
            delivered: Option.some(3),
            reason: Option.some('PersonStopped'),
          }),
        }),
      ),
    )
    expect(decodeLine('{"event":"stopped","turn":"run-1","cooldown_ms":0}')).toEqual(
      Option.some(HelperLine.cases.Stopped.make({ turn: 'run-1', cooldown: 0 })),
    )
  })

  it('a line that is not the protocol decodes to nothing', () => {
    expect(decodeLine('fake helper started')).toEqual(Option.none())
    expect(decodeLine('{"id":"7","ok":true,"result":{}}')).toEqual(Option.none())
    expect(decodeLine('{"event":"started"}')).toEqual(Option.none())
  })

  it.effect('writes a request as the helper’s method table names it', () =>
    Effect.gen(function* () {
      const click = yield* requestLine({
        id: 9,
        call: HelperCall.cases.ClickPoint.make({
          window,
          x: 10,
          y: 20,
          look: 'abc',
          count: 2,
          button: 'right',
        }),
        turn: Option.some('run-1'),
        budget: 5000,
      })
      expect(written(click)).toEqual({
        id: 9,
        method: 'click',
        params: {
          window,
          x: 10,
          y: 20,
          screenshotId: 'abc',
          click_count: 2,
          mouse_button: 'right',
        },
        turn: 'run-1',
        budget_ms: 5000,
      })
      const status = yield* requestLine({
        id: 1,
        call: HelperCall.cases.Status.make({}),
        turn: Option.none(),
        budget: 3000,
      })
      // An idle status carries no turn; `params` is required even when empty.
      expect(written(status)).toEqual({ id: 1, method: 'status', params: {}, budget_ms: 3000 })
    }),
  )

  it('reads change nothing; input and a launch do', () => {
    expect(changes(HelperCall.cases.WindowState.make({ window }))).toBe(false)
    expect(changes(HelperCall.cases.ListApps.make({}))).toBe(false)
    expect(changes(HelperCall.cases.TypeText.make({ window, text: 'a' }))).toBe(true)
    expect(changes(HelperCall.cases.LaunchApp.make({ app: 'Notepad', id: 'x' }))).toBe(true)
  })
})

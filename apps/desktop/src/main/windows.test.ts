import { describe, expect, it } from '@effect/vitest'
import {
  AppId,
  DeviceAnswer,
  LookId,
  WindowAction,
  WindowId,
  WindowResult,
  type WindowRefusal,
} from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { HelperCall, HelperReply } from './wire.ts'
import { Performed, blankTable, perform, type Asking } from './windows.ts'

const answered = (result: typeof Schema.Json.Type) => HelperReply.cases.Answered.make({ result })
const refusedBy = (name: string) =>
  HelperReply.cases.Refused.make({ name, delivered: Option.none(), reason: Option.none() })
const state = (look: string) =>
  answered({
    window: { app: 'notepad', id: 'h1' },
    text: '0 Window "Notes"',
    truncated: true,
    screenshot: { id: look, width: 800, height: 600, png: 'iVBORw0KGgo=' },
  })
const listed = answered([
  { app: 'notepad', id: 'h1', pid: 4, title: 'Notes - Notepad', inputAccess: 'Allowed' },
])

/**
 * A helper that answers each request with the next scripted reply and records what was asked.
 * This is the helper's side of the mapping only; the process and its pipes are `helper.test.ts`.
 */
const scripted = (replies: ReadonlyArray<HelperReply>) => {
  const asked: Array<HelperCall> = []
  const asking: Asking = (call) =>
    Effect.sync(() => {
      const reply = replies[asked.length]
      asked.push(call)
      return reply === undefined ? HelperReply.cases.Lost.make({ sent: false }) : reply
    })
  return { asked, asking, methods: () => asked.map((call) => call._tag) }
}

const w1 = WindowId.make('w1')
const did = (result: WindowResult) =>
  Performed.cases.Answered.make({ answer: DeviceAnswer.cases.Did.make({ result }) })
const declined = (reason: WindowRefusal) =>
  Performed.cases.Answered.make({ answer: DeviceAnswer.cases.Declined.make({ reason }) })
const failed = Performed.cases.Answered.make({ answer: DeviceAnswer.cases.Failed.make({}) })
const unknown = Performed.cases.Unknown.make({})

/** What a result shows, in a few words: its kind, and the look or the count that matters. */
const seen = (performed: Performed): string => {
  if (!Performed.guards.Answered(performed)) return performed._tag
  if (!DeviceAnswer.guards.Did(performed.answer)) return performed.answer._tag
  return WindowResult.match(performed.answer.result, {
    Apps: ({ apps }) => `Apps ${apps.length}`,
    Windows: ({ windows }) => `Windows ${windows.length}`,
    Seen: ({ view }) => `Seen ${view.look}`,
    Typed: ({ view, complete, sent }) => `Typed ${view.look} ${String(complete)} ${sent}`,
    Closed: () => 'Closed',
    Closing: ({ view }) => `Closing ${view.look}`,
  })
}

/** A turn that has listed its one window and looked at it once, as `look1`. */
const looked = (after: ReadonlyArray<HelperReply>) =>
  Effect.gen(function* () {
    const helper = scripted([listed, state('look1'), ...after])
    const table = blankTable()
    yield* perform(helper.asking, table, WindowAction.cases.ListWindows.make({}))
    yield* perform(helper.asking, table, WindowAction.cases.Look.make({ window: w1 }))
    return { helper, table, run: (action: WindowAction) => perform(helper.asking, table, action) }
  })

describe('Vivid’s actions as the helper’s requests', () => {
  it.effect('lists every app, terminals included, counting what does not fit as skipped', () =>
    Effect.gen(function* () {
      const helper = scripted([
        answered({
          apps: [
            { name: 'Terminal', id: 'machine:Terminal.lnk', launchable: true },
            { name: '', id: 'machine:Nameless.lnk' },
          ],
          skipped: 2,
        }),
      ])
      const result = yield* perform(
        helper.asking,
        blankTable(),
        WindowAction.cases.ListApps.make({}),
      )
      expect(result).toEqual(
        did(
          WindowResult.cases.Apps.make({
            apps: [{ id: AppId.make('machine:Terminal.lnk'), name: 'Terminal' }],
            skipped: 3,
          }),
        ),
      )
    }),
  )

  it.effect('lists windows with their titles under names of this turn’s own', () =>
    Effect.gen(function* () {
      const helper = scripted([listed, listed])
      const table = blankTable()
      const first = yield* perform(helper.asking, table, WindowAction.cases.ListWindows.make({}))
      expect(first).toEqual(
        did(
          WindowResult.cases.Windows.make({
            windows: [{ id: w1, app: 'notepad', title: 'Notes - Notepad' }],
          }),
        ),
      )
      // Listed again, the same window keeps its name.
      expect(yield* perform(helper.asking, table, WindowAction.cases.ListWindows.make({}))).toEqual(
        first,
      )
    }),
  )

  it.effect('a look is the picture and the outline, named by the picture’s id', () =>
    Effect.gen(function* () {
      const { helper, run } = yield* looked([state('look2')])
      const result = yield* run(WindowAction.cases.Look.make({ window: w1 }))
      expect(result).toEqual(
        did(
          WindowResult.cases.Seen.make({
            view: {
              window: w1,
              app: 'notepad',
              look: LookId.make('look2'),
              picture: 'iVBORw0KGgo=',
              width: 800,
              height: 600,
              outline: '0 Window "Notes"',
              truncated: true,
            },
          }),
        ),
      )
      expect(helper.asked[2]).toEqual(
        HelperCall.cases.WindowState.make({ window: { app: 'notepad', id: 'h1' } }),
      )
    }),
  )

  it.effect('a window this turn never listed is gone, and the helper is not asked', () =>
    Effect.gen(function* () {
      const helper = scripted([])
      const result = yield* perform(
        helper.asking,
        blankTable(),
        WindowAction.cases.Look.make({ window: WindowId.make('w9') }),
      )
      expect(result).toEqual(declined('WindowGone'))
      expect(helper.asked).toEqual([])
    }),
  )

  it.effect('a click answers with the window as it is afterwards', () =>
    Effect.gen(function* () {
      const { helper, run } = yield* looked([answered({}), state('look2')])
      const result = yield* run(
        WindowAction.cases.Click.make({
          window: w1,
          look: LookId.make('look1'),
          at: { x: 5, y: 6 },
          button: 'left',
          times: 2,
        }),
      )
      expect(seen(result)).toBe('Seen look2')
      expect(helper.methods().slice(2)).toEqual(['ClickPoint', 'WindowState'])
    }),
  )

  it.effect('an element or a point from an older look is stale, and nothing is sent', () =>
    Effect.gen(function* () {
      const { helper, run } = yield* looked([answered({}), state('look2')])
      const press = WindowAction.cases.Press.make({
        window: w1,
        look: LookId.make('look1'),
        element: 1,
      })
      yield* run(press)
      // The press above made `look1` old: the same numbers now mean something else.
      expect(yield* run(press)).toEqual(declined('LookStale'))
      expect(helper.methods().slice(2)).toEqual(['ClickElement', 'WindowState'])
    }),
  )

  it.effect('scrolling down is positive wheel units, 120 a notch', () =>
    Effect.gen(function* () {
      const { helper, run } = yield* looked([answered({}), state('look2')])
      yield* run(
        WindowAction.cases.Scroll.make({
          window: w1,
          look: LookId.make('look1'),
          at: { x: 1, y: 2 },
          direction: 'down',
          notches: 3,
        }),
      )
      expect(helper.asked[2]).toEqual(
        HelperCall.cases.Scroll.make({
          window: { app: 'notepad', id: 'h1' },
          x: 1,
          y: 2,
          look: 'look1',
          scrollX: 0,
          scrollY: 360,
        }),
      )
    }),
  )

  it.effect('typing cut short says how much went in, so it is never typed again', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([
        HelperReply.cases.Refused.make({
          name: 'TypingInterrupted',
          delivered: Option.some(3),
          reason: Option.some('NativeInputFailed'),
        }),
        state('look2'),
      ])
      const result = yield* run(WindowAction.cases.Type.make({ window: w1, text: 'hello' }))
      expect(seen(result)).toBe('Typed look2 false 3')
    }),
  )

  it.effect('typing interrupted before anything went in is what interrupted it', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([
        HelperReply.cases.Refused.make({
          name: 'TypingInterrupted',
          delivered: Option.some(0),
          reason: Option.some('ForegroundRefused'),
        }),
      ])
      expect(yield* run(WindowAction.cases.Type.make({ window: w1, text: 'hello' }))).toEqual(
        declined('NotInFront'),
      )
    }),
  )

  it.effect('closing answers closed, or shows the question the app asked first', () =>
    Effect.gen(function* () {
      const closing = yield* looked([answered({ outcome: 'closePending' }), state('look2')])
      const pending = yield* closing.run(WindowAction.cases.Close.make({ window: w1 }))
      expect(seen(pending)).toBe('Closing look2')
      expect(closing.helper.asked[2]).toEqual(
        HelperCall.cases.PressKey.make({ window: { app: 'notepad', id: 'h1' }, key: 'Alt+F4' }),
      )
      const closed = yield* looked([answered({ outcome: 'closed' })])
      expect(yield* closed.run(WindowAction.cases.Close.make({ window: w1 }))).toEqual(
        did(WindowResult.cases.Closed.make({})),
      )
    }),
  )

  it.effect('opening launches by the listed name and id, then lists the windows', () =>
    Effect.gen(function* () {
      const helper = scripted([
        answered({ apps: [{ name: 'Terminal', id: 'machine:Terminal.lnk' }], skipped: 0 }),
        answered({ pid: 1, app: 'Terminal', id: 'machine:Terminal.lnk' }),
        listed,
      ])
      const table = blankTable()
      yield* perform(helper.asking, table, WindowAction.cases.ListApps.make({}))
      const result = yield* perform(
        helper.asking,
        table,
        WindowAction.cases.Open.make({ app: AppId.make('machine:Terminal.lnk') }),
      )
      expect(seen(result)).toBe('Windows 1')
      expect(helper.asked[1]).toEqual(
        HelperCall.cases.LaunchApp.make({ app: 'Terminal', id: 'machine:Terminal.lnk' }),
      )
    }),
  )

  it.effect.each([
    ['PersonStopped', declined('Stopped')],
    ['ElevatedTarget', declined('Elevated')],
    ['WindowGone', declined('WindowGone')],
    ['ScreenshotStale', declined('LookStale')],
    ['ElementGone', declined('LookStale')],
    ['ForegroundRefused', declined('NotInFront')],
    ['UnknownMethod', declined('Unsupported')],
    ['HookUnavailable', Performed.cases.HooksLost.make({})],
    // The request was wrong and nothing was sent.
    ['InvalidRequest', failed],
    // Something may have gone in: not done, not refused, not failed.
    ['NativeInputFailed', unknown],
    ['RequestBudgetExhausted', unknown],
    ['SomethingNew', unknown],
  ] as const)('the helper refusing a change with %s', ([name, expected]) =>
    Effect.gen(function* () {
      const { run } = yield* looked([refusedBy(name)])
      expect(yield* run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        expected,
      )
    }),
  )

  it.effect('a read that fails for an unnamed reason simply failed', () =>
    Effect.gen(function* () {
      const helper = scripted([refusedBy('AppInventoryFailed')])
      expect(
        yield* perform(helper.asking, blankTable(), WindowAction.cases.ListApps.make({})),
      ).toEqual(failed)
    }),
  )

  it.effect('a change that was written and got no reply is unknown; one never written failed', () =>
    Effect.gen(function* () {
      const keys = WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' })
      const sent = yield* looked([HelperReply.cases.Lost.make({ sent: true })])
      expect(yield* sent.run(keys)).toEqual(unknown)
      const unsent = yield* looked([HelperReply.cases.Lost.make({ sent: false })])
      expect(yield* unsent.run(keys)).toEqual(failed)
    }),
  )

  it.effect('a change that went in but could not be seen afterwards is unknown, not failed', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([answered({}), refusedBy('ScreenshotFailed')])
      expect(yield* run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        unknown,
      )
    }),
  )

  it.effect('a click that closed its window says the window is gone', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([answered({}), refusedBy('WindowGone')])
      expect(yield* run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        declined('WindowGone'),
      )
    }),
  )
})

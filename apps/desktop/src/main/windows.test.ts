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
import { ComputerCall, ComputerReply, ESCAPE_STOPPED } from './wire.ts'
import { Performed, blankTable, perform, type Asking } from './windows.ts'

const answered = (result: typeof Schema.Json.Type) => ComputerReply.cases.Answered.make({ result })
const refusedBy = (name: string) =>
  ComputerReply.cases.Refused.make({ name, delivered: Option.none(), reason: Option.none() })
/** One window state as the Computer itself answers `get_window_state` (`vendor/computer/README.md`). */
const state = (look: string) =>
  answered({
    window: { app: 'notepad', id: 7 },
    screenshots: [{ id: look, url: 'data:image/png;base64,iVBORw0KGgo=', width: 800, height: 600 }],
    accessibility: { tree: '0 Window "Notes"', focused_element: 1 },
  })
/** One window as the Computer itself lists them: an integer id. */
const listed = answered([{ app: 'notepad', id: 7, title: 'Notes - Notepad' }])

/**
 * A Computer that answers each request with the next scripted reply and records what was asked.
 * This is the mapping's side only; the process and its pipes are `Computer.test.ts`.
 */
const scripted = (replies: ReadonlyArray<ComputerReply>) => {
  const asked: Array<ComputerCall> = []
  const asking: Asking = (call) =>
    Effect.sync(() => {
      const reply = replies[asked.length]
      asked.push(call)
      return reply === undefined ? ComputerReply.cases.Lost.make({ sent: false }) : reply
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
const looked = (after: ReadonlyArray<ComputerReply>) =>
  Effect.gen(function* () {
    const Computer = scripted([
      // list_windows, then the first look.
      listed,
      state('look1'),
      ...after,
    ])
    const table = blankTable()
    yield* perform(Computer.asking, table, WindowAction.cases.ListWindows.make({}))
    yield* perform(Computer.asking, table, WindowAction.cases.Look.make({ window: w1 }))
    return { Computer, table, run: (action: WindowAction) => perform(Computer.asking, table, action) }
  })

describe('Vivid’s actions as the Computer’s requests', () => {
  it.effect('lists every app, named or id-only, counting what does not fit as skipped', () =>
    Effect.gen(function* () {
      const Computer = scripted([
        answered([
          { id: 'machine:Terminal.lnk', displayName: 'Terminal' },
          { id: 'machine:Nameless.lnk', displayName: '' },
          { id: 'machine' },
        ]),
      ])
      const result = yield* perform(
        Computer.asking,
        blankTable(),
        WindowAction.cases.ListApps.make({}),
      )
      expect(result).toEqual(
        did(
          WindowResult.cases.Apps.make({
            apps: [
              { id: AppId.make('machine:Terminal.lnk'), name: 'Terminal' },
              { id: AppId.make('machine'), name: 'machine' },
            ],
            skipped: 1,
          }),
        ),
      )
    }),
  )

  it.effect('lists windows with their titles under names of this turn’s own', () =>
    Effect.gen(function* () {
      const Computer = scripted([listed, listed])
      const table = blankTable()
      const first = yield* perform(Computer.asking, table, WindowAction.cases.ListWindows.make({}))
      expect(first).toEqual(
        did(
          WindowResult.cases.Windows.make({
            windows: [{ id: w1, app: 'notepad', title: 'Notes - Notepad' }],
          }),
        ),
      )
      // Listed again, the same window keeps its name.
      expect(yield* perform(Computer.asking, table, WindowAction.cases.ListWindows.make({}))).toEqual(
        first,
      )
    }),
  )

  it.effect('a look is the picture and the outline, named by the picture’s id', () =>
    Effect.gen(function* () {
      const { Computer, run } = yield* looked([state('look2')])
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
              truncated: false,
            },
          }),
        ),
      )
      expect(Computer.asked[2]).toEqual(
        ComputerCall.cases.WindowState.make({ window: { app: 'notepad', id: '7' } }),
      )
    }),
  )

  it.effect('a window this turn never listed is gone, and the Computer is not asked', () =>
    Effect.gen(function* () {
      const Computer = scripted([])
      const result = yield* perform(
        Computer.asking,
        blankTable(),
        WindowAction.cases.Look.make({ window: WindowId.make('w9') }),
      )
      expect(result).toEqual(declined('WindowGone'))
      expect(Computer.asked).toEqual([])
    }),
  )

  it.effect('a click answers with the window as it is afterwards', () =>
    Effect.gen(function* () {
      const { Computer, run } = yield* looked([answered({}), state('look2')])
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
      expect(Computer.methods().slice(2)).toEqual(['ClickPoint', 'WindowState'])
    }),
  )

  it.effect('an element or a point from an older look is stale, and nothing is sent', () =>
    Effect.gen(function* () {
      const { Computer, run } = yield* looked([answered({}), state('look2')])
      const press = WindowAction.cases.Press.make({
        window: w1,
        look: LookId.make('look1'),
        element: 1,
      })
      yield* run(press)
      // The press above made `look1` old: the same numbers now mean something else.
      expect(yield* run(press)).toEqual(declined('LookStale'))
      expect(Computer.methods().slice(2)).toEqual(['ClickElement', 'WindowState'])
    }),
  )

  it.effect('scrolling down is positive wheel units, 120 a notch', () =>
    Effect.gen(function* () {
      const { Computer, run } = yield* looked([answered({}), state('look2')])
      yield* run(
        WindowAction.cases.Scroll.make({
          window: w1,
          look: LookId.make('look1'),
          at: { x: 1, y: 2 },
          direction: 'down',
          notches: 3,
        }),
      )
      expect(Computer.asked[2]).toEqual(
        ComputerCall.cases.Scroll.make({
          window: { app: 'notepad', id: '7' },
          x: 1,
          y: 2,
          look: 'look1',
          scrollX: 0,
          scrollY: 360,
        }),
      )
    }),
  )

  it.effect('the Computer refusing a change is unknown when it may have gone in, failed when not', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([refusedBy('NativeInputFailed')])
      // Something may have gone in: not done, not refused, not failed.
      expect(yield* run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        unknown,
      )
      // The budget gate rejects a request before anything runs: nothing was sent.
      const rejected = yield* looked([
        refusedBy('computer-use request budget exhausted'),
      ])
      expect(yield* rejected.run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        failed,
      )
    }),
  )

  it.effect('Escape refuses the change in flight as Stopped', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([refusedBy(ESCAPE_STOPPED)])
      expect(yield* run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        declined('Stopped'),
      )
    }),
  )

  it.effect('a read that fails for an unnamed reason simply failed', () =>
    Effect.gen(function* () {
      const Computer = scripted([refusedBy('something went wrong')])
      expect(
        yield* perform(Computer.asking, blankTable(), WindowAction.cases.ListApps.make({})),
      ).toEqual(failed)
    }),
  )

  it.effect('a change that was written and got no reply is unknown; one never written failed', () =>
    Effect.gen(function* () {
      const keys = WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' })
      const sent = yield* looked([ComputerReply.cases.Lost.make({ sent: true })])
      expect(yield* sent.run(keys)).toEqual(unknown)
      const unsent = yield* looked([ComputerReply.cases.Lost.make({ sent: false })])
      expect(yield* unsent.run(keys)).toEqual(failed)
    }),
  )

  it.effect('a change that went in but could not be seen afterwards is unknown, not failed', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([answered({}), refusedBy('something went wrong')])
      expect(yield* run(WindowAction.cases.Keys.make({ window: w1, keys: 'Enter' }))).toEqual(
        unknown,
      )
    }),
  )

  it.effect('closing a window sends the exact Alt+F4 and answers with what it now shows', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([answered(null), state('look2')])
      // The supervisor says nothing about what a key did; what the window now shows is the answer.
      expect(seen(yield* run(WindowAction.cases.Close.make({ window: w1 })))).toBe('Seen look2')
    }),
  )

  it.effect('opening launches by the inventory id, then lists the windows', () =>
    Effect.gen(function* () {
      const Computer = scripted([
        answered([{ id: 'machine:Terminal.lnk', displayName: 'Terminal' }]),
        answered({}),
        listed,
      ])
      const table = blankTable()
      yield* perform(Computer.asking, table, WindowAction.cases.ListApps.make({}))
      const result = yield* perform(
        Computer.asking,
        table,
        WindowAction.cases.Open.make({ app: AppId.make('machine:Terminal.lnk') }),
      )
      expect(seen(result)).toBe('Windows 1')
      expect(Computer.asked[1]).toEqual(
        ComputerCall.cases.LaunchApp.make({ app: 'Terminal', id: 'machine:Terminal.lnk' }),
      )
    }),
  )

  it.effect('typing reports what the Computer says, complete when it says nothing about it', () =>
    Effect.gen(function* () {
      const { run } = yield* looked([answered({}), state('look2')])
      const result = yield* run(WindowAction.cases.Type.make({ window: w1, text: 'hello' }))
      expect(seen(result)).toBe('Typed look2 true 5')
    }),
  )
})

import {
  AppId,
  AppName,
  DeviceAnswer,
  InstalledApp,
  LookId,
  OpenWindow,
  WindowAction,
  WindowId,
  WindowResult,
  WindowView,
  type WindowRefusal,
} from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { HelperCall, HelperReply, changes, type HelperWindow } from './wire.ts'

/**
 * The one place where Vivid's vocabulary for a Person's computer (`WindowAction`, `WindowResult`,
 * `WindowRefusal` in `packages/contracts/src/windows.ts`) meets the helper's methods
 * (`apps/desktop/native/windows/README.md`, the method table).
 *
 * Three rules shape every mapping:
 * - A change answers with the window as it is afterwards: after every input the helper has
 *   already thrown away its picture and its element numbers for that window (README, "Every
 *   input attempt after activation invalidates both the screenshot id and text indexes"), so this
 *   module looks again and that fresh view is the answer.
 * - A change whose outcome is not known is never answered. When a request that changes something
 *   was written and no reply came, or the helper's reply says it cannot tell what went in, the
 *   result is `Unknown`: the caller sends nothing, and the server records the outcome as unknown.
 * - Nothing here is a rule of Vivid's about what may be done. Once the Person has allowed their
 *   computer, any app and any window is worked in; the only refusals are what happened (a stop,
 *   a window that is gone, a stale look) and what Windows does not allow.
 */

/** How one piece of work ended, for the turn that asked. */
export const Performed = Schema.TaggedUnion({
  /** There is an answer to send: done, declined for a named reason, or failed. */
  Answered: { answer: DeviceAnswer },
  /** A change was sent and what came of it is not known. Nothing is answered. */
  Unknown: {},
  /**
   * The helper's Escape hooks are gone (`HookUnavailable`). Nothing was sent. Without the hooks
   * the Person cannot stop Vivid from the keyboard, so the turn ends and the notice comes down.
   */
  HooksLost: {},
})
export type Performed = typeof Performed.Type

const did = (result: WindowResult) =>
  Performed.cases.Answered.make({ answer: DeviceAnswer.cases.Did.make({ result }) })
const declined = (reason: WindowRefusal) =>
  Performed.cases.Answered.make({ answer: DeviceAnswer.cases.Declined.make({ reason }) })
const failed = Performed.cases.Answered.make({ answer: DeviceAnswer.cases.Failed.make({}) })
const unknown = Performed.cases.Unknown.make({})
/** Whether the work ended as a plain failure, with nothing more known. */
const plainlyFailed = (outcome: Performed) =>
  Performed.guards.Answered(outcome) && DeviceAnswer.guards.Failed(outcome.answer)

/** A step ended the work early; `outcome` is how. Internal to this module's control flow. */
class Ended extends Schema.TaggedError<Ended>()(
  'Ended',
  { outcome: Performed },
  { title: 'The work on the Person’s computer ended' },
) {}

/**
 * The helper's failure names that are one of the contract's refusals. Every name is from
 * `failure.cs`; the stale-look family is one refusal because Vivid does the same thing for each:
 * look again.
 */
const REFUSALS = {
  PersonStopped: 'Stopped',
  ElevatedTarget: 'Elevated',
  WindowGone: 'WindowGone',
  ScreenshotStale: 'LookStale',
  ScreenshotRequired: 'LookStale',
  ScreenshotIdRequired: 'LookStale',
  TextRequired: 'LookStale',
  ElementGone: 'LookStale',
  ForegroundRefused: 'NotInFront',
  UnknownMethod: 'Unsupported',
} as const satisfies Record<string, WindowRefusal>
const refusalName = Schema.decodeUnknownOption(
  Schema.Literals([
    'PersonStopped',
    'ElevatedTarget',
    'WindowGone',
    'ScreenshotStale',
    'ScreenshotRequired',
    'ScreenshotIdRequired',
    'TextRequired',
    'ElementGone',
    'ForegroundRefused',
    'UnknownMethod',
  ]),
)

/**
 * The failures the helper raises before it sends anything, which are not a contract refusal:
 * the request was wrong, the app is not in the inventory, the turn is not the helper's. For a
 * change these are a plain `Failed`; every other unnamed failure of a change (a native batch
 * that was cut short, a budget that ran out, a defect) may have sent something, and is unknown.
 */
const nothingSent = Schema.is(
  Schema.Literals([
    'InvalidRequest',
    'InvalidClickCount',
    'BadJson',
    'ModifierHeld',
    'AppNameRequired',
    'AppInventoryRequired',
    'AppNotInstalled',
    'AppNameAmbiguous',
    'LaunchFailed',
    'NoActiveTurn',
    'TurnMismatch',
  ]),
)

/** What a helper failure means for the request that got it. */
const refused = (call: HelperCall, name: string): Performed => {
  if (name === 'HookUnavailable') return Performed.cases.HooksLost.make({})
  const known = refusalName(name)
  if (Option.isSome(known)) return declined(REFUSALS[known.value])
  return changes(call) && !nothingSent(name) ? unknown : failed
}

/** What no reply, or a reply that is not the method's shape, means for the request. */
const lost = (call: HelperCall, sent: boolean): Performed =>
  sent && changes(call) ? unknown : failed

/** Sends one request to the helper within this turn and this work's deadline. */
export type Asking = (call: HelperCall) => Effect.Effect<HelperReply>

/**
 * What one turn remembers. The helper's window ids hold a process id and a window handle, and can
 * be longer than the contract allows, so each window gets a short name of this turn's own
 * (`w1`, `w2`); the helper's `{app, id}` pair never leaves this computer. `looks` is the latest
 * look of each window: the helper checks a picture's id itself but has no id for the outline, so
 * an element number from an older look is refused here.
 */
export interface Table {
  readonly apps: Map<AppId, AppName>
  readonly windows: Map<WindowId, HelperWindow>
  readonly named: Map<string, WindowId>
  readonly looks: Map<WindowId, LookId>
}
export const blankTable = (): Table => ({
  apps: new Map(),
  windows: new Map(),
  named: new Map(),
  looks: new Map(),
})

/** Asks, and decodes the result with the schema of the method asked. Unknown data stops here. */
const ask = <S extends Schema.Top & { readonly DecodingServices: never }>(
  asking: Asking,
  call: HelperCall,
  result: S,
) =>
  Effect.gen(function* () {
    const reply = yield* asking(call)
    return yield* HelperReply.match(reply, {
      Refused: ({ name }) => Effect.fail(new Ended({ outcome: refused(call, name) })),
      Lost: ({ sent }) => Effect.fail(new Ended({ outcome: lost(call, sent) })),
      Answered: (answered) =>
        Schema.decodeUnknownEffect(result)(answered.result).pipe(
          // A reply of the wrong shape is as good as none: for a change, it was still sent.
          Effect.mapError(() => new Ended({ outcome: lost(call, true) })),
        ),
    })
  })

const Nothing = Schema.Struct({})
const AppList = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ name: Schema.String, id: Schema.String })),
  skipped: Schema.Int,
})
const WindowList = Schema.Array(
  Schema.Struct({ app: Schema.String, id: Schema.String, title: Schema.String }),
)
const State = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  screenshot: Schema.Struct({
    id: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
    png: Schema.String,
  }),
})
/** `press_key` answers `{}`, or what an exact Alt+F4 did (README, the `press_key` row). */
const Pressed = Schema.Struct({
  outcome: Schema.OptionFromOptionalKey(Schema.Literals(['closed', 'closePending'])),
})
const listedApp = Schema.decodeUnknownOption(InstalledApp)
const appName = Schema.decodeUnknownOption(AppName)
const lookId = Schema.decodeUnknownOption(LookId)

/** A window Vivid named must be one this turn listed; otherwise it is gone as far as Vivid knows. */
const windowOf = (table: Table, window: WindowId): Effect.Effect<HelperWindow, Ended> =>
  Option.match(Option.fromUndefinedOr(table.windows.get(window)), {
    onNone: () => Effect.fail(new Ended({ outcome: declined('WindowGone') })),
    onSome: (known) => Effect.succeed(known),
  })

/** An element number or a point belongs to one look; any other look of that window is stale. */
const latest = (table: Table, window: WindowId, look: LookId) =>
  table.looks.get(window) === look
    ? Effect.void
    : Effect.fail(new Ended({ outcome: declined('LookStale') }))

/**
 * `list_apps`. Every app the helper lists is offered. An entry whose id or name does not fit the
 * contract's bounds is counted with the helper's own `skipped`, never cut to fit: a cut id would
 * name nothing.
 */
const listApps = Effect.fn('DesktopWindows.listApps')(function* (asking: Asking, table: Table) {
  const listed = yield* ask(asking, HelperCall.cases.ListApps.make({}), AppList)
  const apps = listed.apps.flatMap((entry) => Option.toArray(listedApp(entry)))
  table.apps.clear()
  for (const app of apps) table.apps.set(app.id, app.name)
  return WindowResult.cases.Apps.make({
    apps,
    skipped: listed.skipped + listed.apps.length - apps.length,
  })
})

/** The short name this turn gives a helper window, the same one each time it is listed. */
const nameWindow = (table: Table, id: string): WindowId =>
  Option.getOrElse(Option.fromUndefinedOr(table.named.get(id)), () => {
    const minted = WindowId.make(`w${table.named.size + 1}`)
    table.named.set(id, minted)
    return minted
  })

/** `list_windows`, with titles: a title is how Vivid tells two windows of one app apart. */
const listWindows = Effect.fn('DesktopWindows.listWindows')(function* (
  asking: Asking,
  table: Table,
) {
  const listed = yield* ask(asking, HelperCall.cases.ListWindows.make({}), WindowList)
  table.windows.clear()
  const windows = listed.flatMap((entry) =>
    Option.toArray(
      Option.map(appName(entry.app), (app) => {
        const id = nameWindow(table, entry.id)
        table.windows.set(id, { app: entry.app, id: entry.id })
        // The contract bounds a title at 400; the helper's buffer is longer. The start is kept.
        return OpenWindow.make({ id, app, title: entry.title.slice(0, 400) })
      }),
    ),
  )
  return WindowResult.cases.Windows.make({ windows })
})

/** `get_window_state` with the picture and the outline: one look, whose id is the picture's. */
const look = Effect.fn('DesktopWindows.look')(function* (
  asking: Asking,
  table: Table,
  window: WindowId,
) {
  const known = yield* windowOf(table, window)
  const call = HelperCall.cases.WindowState.make({ window: known })
  const state = yield* ask(asking, call, State)
  const seen = Option.all({ app: appName(known.app), look: lookId(state.screenshot.id) })
  if (Option.isNone(seen)) return yield* new Ended({ outcome: failed })
  table.looks.set(window, seen.value.look)
  return WindowView.make({
    window,
    app: seen.value.app,
    look: seen.value.look,
    picture: state.screenshot.png,
    width: state.screenshot.width,
    height: state.screenshot.height,
    outline: state.text,
    truncated: state.truncated,
  })
})

/**
 * The look after a change. The change has happened, so a look that merely fails is not a failed
 * action: what the window now shows is unknown, and that is what is reported. A named refusal
 * from the look (the window is gone, the Person stopped) is still the true state and is said.
 */
const lookAfter = (asking: Asking, table: Table, window: WindowId) =>
  look(asking, table, window).pipe(
    Effect.mapError((ended) =>
      plainlyFailed(ended.outcome) ? new Ended({ outcome: unknown }) : ended,
    ),
  )

/** One input to a window, then the window as it now is. The old look is void whatever happens. */
const change = Effect.fn('DesktopWindows.change')(function* (
  asking: Asking,
  table: Table,
  input: { readonly window: WindowId; readonly call: HelperCall },
) {
  table.looks.delete(input.window)
  yield* ask(asking, input.call, Nothing)
  return WindowResult.cases.Seen.make({ view: yield* lookAfter(asking, table, input.window) })
})

/**
 * Typing, by keyboard or into an element. `TypingInterrupted` carries how many UTF-16 units went
 * in (README, "`TypingInterrupted.delivered`"): with some delivered the answer is `Typed`,
 * incomplete, so Vivid never types them again; with none, what interrupted it is the answer.
 */
const type = Effect.fn('DesktopWindows.type')(function* (
  asking: Asking,
  table: Table,
  input: { readonly window: WindowId; readonly call: HelperCall; readonly length: number },
) {
  table.looks.delete(input.window)
  const reply = yield* asking(input.call)
  const sent = yield* HelperReply.match(reply, {
    Answered: () => Effect.succeed({ complete: true, sent: input.length }),
    Lost: (gone) => Effect.fail(new Ended({ outcome: lost(input.call, gone.sent) })),
    Refused: ({ name, delivered, reason }) => {
      const partial = Option.filter(delivered, (count) => count > 0)
      if (name === 'TypingInterrupted' && Option.isSome(partial))
        return Effect.succeed({ complete: false, sent: partial.value })
      const cause = name === 'TypingInterrupted' ? Option.getOrElse(reason, () => name) : name
      return Effect.fail(new Ended({ outcome: refused(input.call, cause) }))
    },
  })
  const view = yield* lookAfter(asking, table, input.window)
  return WindowResult.cases.Typed.make({ view, complete: sent.complete, sent: sent.sent })
})

/**
 * A key or a chord, and closing. The helper answers an exact Alt+F4 with what the window did:
 * `closed`, or `closePending` when the app asked something first (unsaved changes), which is
 * shown to Vivid as `Closing` and never pressed again by this module.
 */
const press = Effect.fn('DesktopWindows.press')(function* (
  asking: Asking,
  table: Table,
  input: { readonly window: WindowId; readonly key: string },
) {
  const known = yield* windowOf(table, input.window)
  table.looks.delete(input.window)
  const call = HelperCall.cases.PressKey.make({ window: known, key: input.key })
  const pressed = yield* ask(asking, call, Pressed)
  if (Option.contains(pressed.outcome, 'closed')) {
    table.windows.delete(input.window)
    return WindowResult.cases.Closed.make({})
  }
  const view = yield* lookAfter(asking, table, input.window)
  return Option.isSome(pressed.outcome)
    ? WindowResult.cases.Closing.make({ view })
    : WindowResult.cases.Seen.make({ view })
})

/** `launch_app`, then the windows as they now are: a new app shows up there, a moment later. */
const open = Effect.fn('DesktopWindows.open')(function* (asking: Asking, table: Table, app: AppId) {
  // The helper launches by name from its own inventory of this turn, with the id to tell two
  // apps of one name apart; an id this turn never listed names nothing to launch.
  const name = Option.fromUndefinedOr(table.apps.get(app))
  if (Option.isNone(name)) return yield* new Ended({ outcome: failed })
  yield* ask(asking, HelperCall.cases.LaunchApp.make({ app: name.value, id: app }), Nothing)
  return yield* listWindows(asking, table).pipe(
    Effect.mapError((ended) =>
      plainlyFailed(ended.outcome) ? new Ended({ outcome: unknown }) : ended,
    ),
  )
})

/** Wheel units for the helper: 120 a notch, positive Y down and positive X right (README). */
const wheel = (direction: 'up' | 'down' | 'left' | 'right', notches: number) => {
  const units = notches * 120
  return {
    up: { scrollX: 0, scrollY: -units },
    down: { scrollX: 0, scrollY: units },
    left: { scrollX: -units, scrollY: 0 },
    right: { scrollX: units, scrollY: 0 },
  }[direction]
}

/** The request for an action on a numbered element or at a point, once its look is the latest. */
const located = Effect.fn('DesktopWindows.located')(function* (
  table: Table,
  action: { readonly window: WindowId; readonly look: LookId },
  call: (window: HelperWindow) => HelperCall,
) {
  const known = yield* windowOf(table, action.window)
  yield* latest(table, action.window, action.look)
  return { window: action.window, call: call(known) }
})

/** Each action as the helper's requests. Exhaustive: a new action fails to typecheck here. */
const route = (asking: Asking, table: Table, action: WindowAction) =>
  WindowAction.match<Effect.Effect<WindowResult, Ended>>(action, {
    ListApps: () => listApps(asking, table),
    ListWindows: () => listWindows(asking, table),
    Open: ({ app }) => open(asking, table, app),
    Look: ({ window }) =>
      look(asking, table, window).pipe(
        Effect.map((view) => WindowResult.cases.Seen.make({ view })),
      ),
    // Press and Choose are both the helper's element click, which uses the element's own way:
    // invoke, then toggle, then select (README, "Single left element clicks prefer…").
    Press: (press_) =>
      located(table, press_, (window) =>
        HelperCall.cases.ClickElement.make({ window, element: press_.element }),
      ).pipe(Effect.flatMap((input) => change(asking, table, input))),
    Choose: (choose) =>
      located(table, choose, (window) =>
        HelperCall.cases.ClickElement.make({ window, element: choose.element }),
      ).pipe(Effect.flatMap((input) => change(asking, table, input))),
    Fill: (fill) =>
      located(table, fill, (window) =>
        HelperCall.cases.FillElement.make({ window, element: fill.element, text: fill.text }),
      ).pipe(
        Effect.flatMap((input) => type(asking, table, { ...input, length: fill.text.length })),
      ),
    Click: (click) =>
      located(table, click, (window) =>
        HelperCall.cases.ClickPoint.make({
          window,
          x: click.at.x,
          y: click.at.y,
          look: click.look,
          count: click.times,
          button: click.button,
        }),
      ).pipe(Effect.flatMap((input) => change(asking, table, input))),
    Scroll: (scroll) =>
      located(table, scroll, (window) =>
        HelperCall.cases.Scroll.make({
          window,
          x: scroll.at.x,
          y: scroll.at.y,
          look: scroll.look,
          ...wheel(scroll.direction, scroll.notches),
        }),
      ).pipe(Effect.flatMap((input) => change(asking, table, input))),
    Type: ({ window, text }) =>
      windowOf(table, window).pipe(
        Effect.flatMap((known) =>
          type(asking, table, {
            window,
            call: HelperCall.cases.TypeText.make({ window: known, text }),
            length: text.length,
          }),
        ),
      ),
    Keys: ({ window, keys }) => press(asking, table, { window, key: keys }),
    Close: ({ window }) => press(asking, table, { window, key: 'Alt+F4' }),
  })

/** Carries out one action on the Person's computer through the helper, to how it ended. */
export const perform = (asking: Asking, table: Table, action: WindowAction) =>
  route(asking, table, action).pipe(
    Effect.map(did),
    Effect.catchTag('Ended', (ended) => Effect.succeed(ended.outcome)),
  )

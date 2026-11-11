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
import {
  ComputerCall,
  ComputerReply,
  changes,
  screenshotPng,
  ESCAPE_STOPPED,
  type ComputerWindow,
} from './wire.ts'

/**
 * The one place where Vivid's vocabulary for a Person's computer (`WindowAction`, `WindowResult`,
 * `WindowRefusal` in `packages/contracts/src/windows.ts`) meets the Computer's methods
 * (`vendor/computer/README.md`).
 *
 * Three rules shape every mapping:
 * - A change answers with the window as it is afterwards: after every input the Computer has
 *   already thrown away its picture and its element numbers for that window (README, "Every
 *   input attempt after activation invalidates both the screenshot id and text indexes"), so this
 *   module looks again and that fresh view is the answer.
 * - A change whose outcome is not known is never answered. When a request that changes something
 *   was written and no reply came, or the Computer's reply says it cannot tell what went in, the
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
   * The Computer's Escape hooks are gone (`HookUnavailable`). Nothing was sent. Without the hooks
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
 * The failures the Computer raises before it sends anything, which are not a contract refusal:
 * the request was wrong, its budget was exhausted before anything ran, or the app is missing.
 * Each is a verified message of the vendored binary (see `vendor/computer/README.md`). For a
 * change these are a plain `Failed`; every other failure of a change may have sent something,
 * and is unknown.
 */
const nothingSent = Schema.is(
  Schema.Literals([
    'computer-use request budget exhausted',
    'app is required',
    'app is not in the inventory',
    'InvalidRequest',
    'BadJson',
  ]),
)

/** What a failure message means for the request that got it. */
const refused = (call: ComputerCall, name: string): Performed => {
  // The supervisor's one long message for a turn the Person stopped; the same Escape as exit 130.
  if (name.startsWith(ESCAPE_STOPPED)) return declined('Stopped')
  return changes(call) && !nothingSent(name) ? unknown : failed
}

/** What no reply, or a reply that is not the method's shape, means for the request. */
const lost = (call: ComputerCall, sent: boolean): Performed =>
  sent && changes(call) ? unknown : failed

/** Sends one request to the Computer within this turn and this work's deadline. */
export type Asking = (call: ComputerCall) => Effect.Effect<ComputerReply>

/**
 * What one turn remembers. The Computer's window ids hold a process id and a window handle, and can
 * be longer than the contract allows, so each window gets a short name of this turn's own
 * (`w1`, `w2`); the Computer's `{app, id}` pair never leaves this computer. `looks` is the latest
 * look of each window: the Computer checks a picture's id itself but has no id for the outline, so
 * an element number from an older look is refused here.
 */
export interface Table {
  readonly apps: Map<AppId, AppName>
  readonly windows: Map<WindowId, ComputerWindow>
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
  call: ComputerCall,
  result: S,
) =>
  Effect.gen(function* () {
    const reply = yield* asking(call)
    return yield* ComputerReply.match(reply, {
      Refused: ({ name }) => Effect.fail(new Ended({ outcome: refused(call, name) })),
      Lost: ({ sent }) => Effect.fail(new Ended({ outcome: lost(call, sent) })),
      Answered: (answered) =>
        Schema.decodeUnknownEffect(result)(answered.result).pipe(
          // A reply of the wrong shape is as good as none: for a change, it was still sent.
          Effect.mapError(() => new Ended({ outcome: lost(call, true) })),
        ),
    })
  })

/**
 * The reply shapes, decoded once at the ingress (`wire.ts`):
 * - `list_apps` is a flat array of the inventory's entries, each with its id and, when the
 *   system names it, a display name;
 * - `list_windows` is a flat array, whose ids are integers (Vivid carries them as strings, and
 *   mints its own short names per turn — `Table`);
 * - `get_window_state` carries the accessibility tree and one or more screenshots, each a PNG
 *   data URL or file path with its size (`screenshotPng` turns either into the PNG itself);
 * - `press_key` answers `{}`, or `null` when there is nothing to say.
 */
const AppEntry = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
})
const WindowEntry = Schema.Struct({
  app: Schema.String,
  id: Schema.Finite,
  title: Schema.optionalKey(Schema.String),
})
const State = Schema.Struct({
  screenshots: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      width: Schema.Finite,
      height: Schema.Finite,
    }),
  ),
  accessibility: Schema.Struct({ tree: Schema.String }),
})
const Nothing = Schema.Union([Schema.Struct({}), Schema.Null])
const Pressed = Schema.Union([
  Schema.Struct({
    outcome: Schema.OptionFromOptionalKey(Schema.Literals(['closed', 'closePending'])),
  }),
  Schema.Null,
])
const listedApp = Schema.decodeUnknownOption(InstalledApp)
const appName = Schema.decodeUnknownOption(AppName)
const lookId = Schema.decodeUnknownOption(LookId)

/** A window Vivid named must be one this turn listed; otherwise it is gone as far as Vivid knows. */
const windowOf = (table: Table, window: WindowId): Effect.Effect<ComputerWindow, Ended> =>
  Effect.fromOption(
    Option.fromUndefinedOr(table.windows.get(window)),
    () => new Ended({ outcome: declined('WindowGone') }),
  )

/** An element number or a point belongs to one look; any other look of that window is stale. */
const latest = (table: Table, window: WindowId, look: LookId) =>
  table.looks.get(window) === look
    ? Effect.void
    : Effect.fail(new Ended({ outcome: declined('LookStale') }))

/**
 * `list_apps`. Every app the Computer lists is offered, named by the system's display name when
 * it has one and by its id when it has not. An entry whose id or name does not fit the
 * contract's bounds is dropped and counted in `skipped`, never cut to fit: a cut id would name
 * nothing. The supervisor's inventory has no skipped count of its own; this one is Vivid's.
 */
const listApps = Effect.fn('DesktopWindows.listApps')(function* (asking: Asking, table: Table) {
  const listed = yield* ask(asking, ComputerCall.cases.ListApps.make({}), Schema.Array(AppEntry))
  table.apps.clear()
  const apps = listed.flatMap((entry) =>
    Option.toArray(
      Option.map(listedApp({ name: entry.displayName ?? entry.id, id: entry.id }), (app) => {
        table.apps.set(app.id, app.name)
        return app
      }),
    ),
  )
  return WindowResult.cases.Apps.make({ apps, skipped: listed.length - apps.length })
})

/** The short name this turn gives a Computer window, the same one each time it is listed. */
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
  const listed = yield* ask(
    asking,
    ComputerCall.cases.ListWindows.make({}),
    Schema.Array(WindowEntry),
  )
  table.windows.clear()
  const windows = listed.flatMap((entry) =>
    Option.toArray(
      Option.map(appName(entry.app), (app) => {
        // The supervisor's window id is an integer; Vivid carries it as a string.
        const knownId = String(entry.id)
        const id = nameWindow(table, knownId)
        table.windows.set(id, { app: entry.app, id: knownId })
        // The contract bounds a title at 400; the Computer's buffer is longer. The start is kept.
        return OpenWindow.make({ id, app, title: (entry.title ?? '').slice(0, 400) })
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
  const call = ComputerCall.cases.WindowState.make({ window: known })
  const state = yield* ask(asking, call, State)
  // One look is one picture: the first screenshot the supervisor returns, whose id is the look
  // id the element numbers and points belong to. Its URL becomes the PNG here, at the ingress
  // (`screenshotPng`); a look without a decodable picture is not a look.
  const seen = state.screenshots[0]
  if (seen === undefined) return yield* new Ended({ outcome: failed })
  const picture = yield* screenshotPng(seen.url)
  const seen_ = Option.all({
    app: appName(known.app),
    look: lookId(seen.id),
    picture,
  })
  if (Option.isNone(seen_)) return yield* new Ended({ outcome: failed })
  table.looks.set(window, seen_.value.look)
  return WindowView.make({
    window,
    app: seen_.value.app,
    look: seen_.value.look,
    picture: seen_.value.picture,
    width: Math.round(seen.width),
    height: Math.round(seen.height),
    outline: state.accessibility.tree,
    truncated: false,
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
  input: { readonly window: WindowId; readonly call: ComputerCall },
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
  input: { readonly window: WindowId; readonly call: ComputerCall; readonly length: number },
) {
  table.looks.delete(input.window)
  const reply = yield* asking(input.call)
  const sent = yield* ComputerReply.match(reply, {
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
 * A key or a chord, and closing. The Computer answers an exact Alt+F4 with what the window did:
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
  const call = ComputerCall.cases.PressKey.make({ window: known, key: input.key })
  const pressed = yield* ask(asking, call, Pressed)
  // The Computer says nothing about what a key did; an exact Alt+F4 that closes says so.
  if (pressed !== null && Option.contains(pressed.outcome, 'closed')) {
    table.windows.delete(input.window)
    return WindowResult.cases.Closed.make({})
  }
  const view = yield* lookAfter(asking, table, input.window)
  return pressed !== null && Option.isSome(pressed.outcome)
    ? WindowResult.cases.Closing.make({ view })
    : WindowResult.cases.Seen.make({ view })
})

/** `launch_app`, then the windows as they now are: a new app shows up there, a moment later. */
const open = Effect.fn('DesktopWindows.open')(function* (asking: Asking, table: Table, app: AppId) {
  // The Computer launches by name from its own inventory of this turn, with the id to tell two
  // apps of one name apart; an id this turn never listed names nothing to launch.
  const name = Option.fromUndefinedOr(table.apps.get(app))
  if (Option.isNone(name)) return yield* new Ended({ outcome: failed })
  yield* ask(asking, ComputerCall.cases.LaunchApp.make({ app: name.value, id: app }), Nothing)
  return yield* listWindows(asking, table).pipe(
    Effect.mapError((ended) =>
      plainlyFailed(ended.outcome) ? new Ended({ outcome: unknown }) : ended,
    ),
  )
})

/** Wheel units for the Computer: 120 a notch, positive Y down and positive X right (README). */
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
  call: (window: ComputerWindow) => ComputerCall,
) {
  const known = yield* windowOf(table, action.window)
  yield* latest(table, action.window, action.look)
  return { window: action.window, call: call(known) }
})

/** Each action as the Computer's requests. Exhaustive: a new action fails to typecheck here. */
const route = (asking: Asking, table: Table, action: WindowAction) =>
  WindowAction.match(action, {
    ListApps: () => listApps(asking, table),
    ListWindows: () => listWindows(asking, table),
    Open: ({ app }) => open(asking, table, app),
    Look: ({ window }) =>
      look(asking, table, window).pipe(
        Effect.map((view) => WindowResult.cases.Seen.make({ view })),
      ),
    // Press and Choose are both the Computer's element click, which uses the element's own way:
    // invoke, then toggle, then select (README, "Single left element clicks prefer…").
    Press: (press_) =>
      located(table, press_, (window) =>
        ComputerCall.cases.ClickElement.make({ window, element: press_.element }),
      ).pipe(Effect.flatMap((input) => change(asking, table, input))),
    Choose: (choose) =>
      located(table, choose, (window) =>
        ComputerCall.cases.ClickElement.make({ window, element: choose.element }),
      ).pipe(Effect.flatMap((input) => change(asking, table, input))),
    Fill: (fill) =>
      located(table, fill, (window) =>
        ComputerCall.cases.FillElement.make({ window, element: fill.element, text: fill.text }),
      ).pipe(
        Effect.flatMap((input) => type(asking, table, { ...input, length: fill.text.length })),
      ),
    Click: (click) =>
      located(table, click, (window) =>
        ComputerCall.cases.ClickPoint.make({
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
        ComputerCall.cases.Scroll.make({
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
            call: ComputerCall.cases.TypeText.make({ window: known, text }),
            length: text.length,
          }),
        ),
      ),
    Keys: ({ window, keys }) => press(asking, table, { window, key: keys }),
    Close: ({ window }) => press(asking, table, { window, key: 'Alt+F4' }),
  })

/** Carries out one action on the Person's computer through the Computer, to how it ended. */
export const perform = (asking: Asking, table: Table, action: WindowAction) =>
  route(asking, table, action).pipe(
    Effect.map(did),
    Effect.catchTag('Ended', (ended) => Effect.succeed(ended.outcome)),
  )

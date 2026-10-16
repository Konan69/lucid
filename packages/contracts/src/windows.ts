import { Effect, Schema } from 'effect'

/**
 * Vivid working in the apps on a Person's own computer: any window, not only the pages of the
 * desktop app's browser (`BrowserAction`).
 *
 * The work is done by the vendored Computer on that person's Windows machine
 * (`apps/desktop/vendor/computer/`), which the desktop app starts and supervises. This is the vocabulary between the server, the desktop
 * app and Vivid's model for it. It follows the helper's protocol, which follows the inspected
 * reference's window methods (list apps and windows, read one window as a picture and a named
 * outline, act on an element or at a point, type, press keys, scroll); the names are Vivid's.
 *
 * It is a different vocabulary from `DesktopAction`, on purpose. Vivid's own Computer is one
 * screen that is all Vivid's, so its actions are points on the whole screen. A Person's computer
 * is theirs: Vivid is let into one app at a time, sees one window at a time, and never the whole
 * screen. An action here always names its window, and the picture is of that window alone.
 *
 * Nothing is asked and nothing is banned once the Person has allowed that computer (`DeviceAccess`,
 * the one switch): no Approval per app or per action, no list of apps Vivid is kept out of, no
 * wait while the Person is at the keyboard. It is their own machine and they said yes to it. What
 * the Person has instead is sight and a stop: a notice on their screen for as long as Vivid is
 * working there, and Escape ends it. The only refusals left are things the computer itself
 * cannot do (`WindowRefusal`).
 */

/** An installed app as the computer lists it. Opaque to everything but that computer. */
export const AppId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)).pipe(
  Schema.brand('AppId'),
)
export type AppId = typeof AppId.Type

/**
 * One open window, named by the computer for the length of one turn. It is not stable across
 * turns or restarts: a window is found again by listing, never remembered.
 */
export const WindowId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)).pipe(
  Schema.brand('WindowId'),
)
export type WindowId = typeof WindowId.Type

/** The name of an app as a Person knows it: "Calculator". What an Approval and the notice say. */
export const AppName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200))
export type AppName = typeof AppName.Type

/**
 * The picture and outline of a window as they were when Vivid last looked. Acting at a point or
 * on a numbered element names the look it came from; the computer refuses a look that is no
 * longer the latest, because anything done to the window since has moved what the numbers mean.
 */
export const LookId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)).pipe(
  Schema.brand('LookId'),
)
export type LookId = typeof LookId.Type

/** A place in the picture of one window, in that picture's own pixels. */
export const WindowPoint = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
})
export interface WindowPoint extends Schema.Schema.Type<typeof WindowPoint> {}

/** The number of an element in a window's outline, as that look numbered it. */
const ElementIndex = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 499 }))

/**
 * One thing Vivid does on the Person's computer.
 *
 * `ListApps`, `ListWindows` and `Look` read; the rest change something. `Press`, `Choose` and
 * `Fill` act on a numbered element through the app's own accessibility, which needs no pointer
 * and does not take the window to the front; `Click`, `Type`, `Keys` and `Scroll` are the pointer
 * and the keyboard, for apps that offer nothing else. There is deliberately no drag, no move and
 * no wait: the helper has none, and none is promised.
 *
 * `Open` starts an app from the list the computer gave. Any app: a terminal is an app.
 */
export const WindowAction = Schema.TaggedUnion({
  ListApps: {},
  ListWindows: {},
  Open: { app: AppId },
  Look: { window: WindowId },
  Press: { window: WindowId, look: LookId, element: ElementIndex },
  Choose: { window: WindowId, look: LookId, element: ElementIndex },
  Fill: {
    window: WindowId,
    look: LookId,
    element: ElementIndex,
    text: Schema.String.check(Schema.isMaxLength(4000)),
  },
  Click: {
    window: WindowId,
    look: LookId,
    at: WindowPoint,
    button: Schema.Literals(['left', 'right']),
    times: Schema.Literals([1, 2, 3]),
  },
  Type: {
    window: WindowId,
    text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4000)),
  },
  Keys: {
    window: WindowId,
    keys: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  },
  Scroll: {
    window: WindowId,
    look: LookId,
    at: WindowPoint,
    direction: Schema.Literals(['up', 'down', 'left', 'right']),
    notches: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  },
  Close: { window: WindowId },
})
export type WindowAction = typeof WindowAction.Type

/** An app the computer has. */
export const InstalledApp = Schema.Struct({ id: AppId, name: AppName })
export interface InstalledApp extends Schema.Schema.Type<typeof InstalledApp> {}

/** An open window: which app it is and what its title bar says, so Vivid can pick the right one. */
export const OpenWindow = Schema.Struct({
  id: WindowId,
  app: AppName,
  title: Schema.String.check(Schema.isMaxLength(400)),
})
export interface OpenWindow extends Schema.Schema.Type<typeof OpenWindow> {}

/**
 * What Vivid sees of one window: a picture of that window alone and its outline, the named
 * elements numbered as `Press`, `Choose` and `Fill` use them. `picture` is PNG, base64, at most
 * 1920 on its longer side; a point in it is a `WindowPoint`. `truncated` says the outline was cut
 * at the computer's bound, so absence from it is not proof of absence from the window.
 */
export const WindowView = Schema.Struct({
  window: WindowId,
  app: AppName,
  look: LookId,
  picture: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  outline: Schema.String,
  truncated: Schema.Boolean,
})
export interface WindowView extends Schema.Schema.Type<typeof WindowView> {}

/**
 * What an action left behind. A change answers with the window as it is afterwards, so Vivid
 * never acts twice on a stale look. `Closing` is a close that an app answered with a question of
 * its own (unsaved changes): the window is still there, shown, for Vivid to answer or leave.
 * `Typed` with `complete: false` is typing the computer cut short; `sent` characters went in and
 * must not be typed again.
 */
export const WindowResult = Schema.TaggedUnion({
  Apps: { apps: Schema.Array(InstalledApp), skipped: Schema.Int },
  Windows: { windows: Schema.Array(OpenWindow) },
  Seen: { view: WindowView },
  Typed: { view: WindowView, complete: Schema.Boolean, sent: Schema.Int },
  Closed: {},
  Closing: { view: WindowView },
})
export type WindowResult = typeof WindowResult.Type

/**
 * Why the computer could not do it. None of these is a rule of Vivid's; each is something that
 * happened or something the operating system does not allow:
 *
 * - `Stopped`: the Person pressed Escape or Stop. The turn is over; Vivid does not continue.
 * - `Elevated`: the window runs as administrator, and Windows does not deliver input from an
 *   ordinary program to it. Vivid says so; the Person can do that step.
 * - `WindowGone`: the window closed or was replaced; list again.
 * - `LookStale`: the look named is not the latest of that window; look again.
 * - `NotInFront`: Windows would not bring the window forward.
 * - `Unsupported`: this computer cannot do that action (not Windows, or the element has no such way).
 */
export const WindowRefusal = Schema.Literals([
  'Stopped',
  'Elevated',
  'WindowGone',
  'LookStale',
  'NotInFront',
  'Unsupported',
])
export type WindowRefusal = typeof WindowRefusal.Type

/** One action on the Person's computer, with what it is for in Vivid's own words. */
export const UseWindowRequest = Schema.Struct({
  action: WindowAction,
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})
export interface UseWindowRequest extends Schema.Schema.Type<typeof UseWindowRequest> {}

/**
 * What came of it, as the server answers Vivid's runtime.
 *
 * - `NotConnected`: no allowed computer of this Person's is listening.
 * - `OutcomeUnknown`: the action was sent and no answer came (the link dropped, the helper died).
 *   It may have happened. It is never sent again without the Person saying so.
 */
export const WindowOutcome = Schema.TaggedUnion({
  Completed: { result: WindowResult },
  Refused: { reason: WindowRefusal },
  NotConnected: {},
  Busy: {},
  RunRequired: {},
  Unavailable: { reason: Schema.String },
  OutcomeUnknown: {},
})
export type WindowOutcome = typeof WindowOutcome.Type

/**
 * What the desktop app on a computer can do, said by the app when it starts listening and never
 * stored as truth: `apps` is true only where Vivid's helper is present and started (Windows).
 * `egress` is true where the app can carry the Computer's browsing out through this computer
 * (`egress.ts`). An installed app from before egress does not say it, and an installed app
 * cannot be rewritten, so a missing word is read as "cannot".
 */
export const DeviceAbility = Schema.Struct({
  pages: Schema.Boolean,
  apps: Schema.Boolean,
  egress: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
})
export interface DeviceAbility extends Schema.Schema.Type<typeof DeviceAbility> {}

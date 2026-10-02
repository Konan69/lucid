import { Schema } from 'effect'
import { ApprovalId, ComputerId } from './identity.js'

/**
 * How a running Computer's screen is watched. `Relay` is a remote-framebuffer socket this server
 * relays, at a path on the app's own origin. `Viewer` is the machine provider's own viewer page
 * for this Person's machine: a short-lived permission, renewed before `expiresAt`, shown in a
 * sandboxed frame and never written down.
 */
export const ComputerScreen = Schema.TaggedUnion({
  Relay: { address: Schema.String },
  Viewer: { address: Schema.String, expiresAt: Schema.Number },
})
export type ComputerScreen = typeof ComputerScreen.Type

/**
 * Where a Person's Computer stands. A Computer is created the first time it is needed and stopped
 * when idle; its files and sign-ins outlive the machine that held them.
 */
export const ComputerState = Schema.TaggedUnion({
  /** This Person has never needed one. */
  Absent: {},
  Starting: { since: Schema.Number },
  Running: {
    since: Schema.Number,
    screen: ComputerScreen,
  },
  Stopped: { since: Schema.Number },
  Failed: { since: Schema.Number, reason: Schema.String },
  /** No machine provider is configured on this installation. */
  Unavailable: {},
})
export type ComputerState = typeof ComputerState.Type

export const Computer = Schema.Struct({
  id: Schema.NullOr(ComputerId),
  state: ComputerState,
  /** Whether a Person, rather than Vivid, currently holds the keyboard and pointer. */
  heldByPerson: Schema.Boolean,
}).annotate({ identifier: 'Computer', title: 'Computer' })
export interface Computer extends Schema.Schema.Type<typeof Computer> {}

export const ComputerResponse = Schema.Struct({ computer: Computer })

/** One command Vivid runs on the Computer. */
export const RunCommandRequest = Schema.Struct({
  command: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
  /** One sentence saying what this does, shown if a Person must approve it. */
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  timeoutSeconds: Schema.optionalKey(Schema.Number),
})
export interface RunCommandRequest extends Schema.Schema.Type<typeof RunCommandRequest> {}

/** What the command produced. Long output is cut with a marker, never silently. */
export const CommandResult = Schema.Struct({
  exitCode: Schema.Number,
  output: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: 'CommandResult', title: 'Command result' })
export interface CommandResult extends Schema.Schema.Type<typeof CommandResult> {}

/** How far a page or a window is scrolled in one step, in notches of a wheel. */
const Notches = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))

/** The four ways anything on the Computer scrolls. */
export const ScrollDirection = Schema.Literals(['up', 'down', 'left', 'right'] as const)
export type ScrollDirection = typeof ScrollDirection.Type

/**
 * One thing Vivid does in the Computer's browser. Targets are words from the page's own outline
 * ("the Sign in button"), never a selector; a tab is named by its position in the outline's list.
 */
export const BrowserAction = Schema.TaggedUnion({
  Open: { address: Schema.String },
  Read: {},
  Click: { target: Schema.String },
  Type: { target: Schema.String, text: Schema.String },
  Press: { key: Schema.String },
  Screenshot: {},
  Scroll: { direction: ScrollDirection, notches: Notches },
  Back: {},
  Forward: {},
  /** Lets a page that is still loading or animating settle before it is read again. */
  Wait: { seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })) },
  OpenTab: { address: Schema.String },
  /** `tab` counts from 1, in the order the last result listed the tabs. */
  ShowTab: { tab: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })) },
  CloseTab: { tab: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })) },
})
export type BrowserAction = typeof BrowserAction.Type

export const BrowseRequest = Schema.Struct({
  action: BrowserAction,
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})
export interface BrowseRequest extends Schema.Schema.Type<typeof BrowseRequest> {}

/** One open tab, as the browser has it. */
export const BrowserTab = Schema.Struct({
  title: Schema.String,
  address: Schema.String,
  /** The tab the next step acts on. Exactly one tab is showing. */
  showing: Schema.Boolean,
})
export interface BrowserTab extends Schema.Schema.Type<typeof BrowserTab> {}

/** What the page looks like after the action: its address, title, readable outline and the tabs. */
export const BrowseResult = Schema.Struct({
  address: Schema.String,
  title: Schema.String,
  outline: Schema.String,
  truncated: Schema.Boolean,
  tabs: Schema.Array(BrowserTab),
}).annotate({ identifier: 'BrowseResult', title: 'Browse result' })
export interface BrowseResult extends Schema.Schema.Type<typeof BrowseResult> {}

/**
 * A place on the Computer's screen, in the pixels of the picture Vivid was last shown. The
 * picture is the whole screen at its real size, so a point in it is a point on the desktop.
 */
export const ScreenPoint = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
})
export interface ScreenPoint extends Schema.Schema.Type<typeof ScreenPoint> {}

/**
 * One thing Vivid does on the Computer's desktop, the way a person does it: by looking at the
 * screen and using the pointer and the keys. It works in any window, not only the browser, which
 * is what the browser steps above cannot do. Every action answers with a fresh picture.
 */
export const DesktopAction = Schema.TaggedUnion({
  Look: {},
  Click: {
    at: ScreenPoint,
    button: Schema.Literals(['left', 'middle', 'right'] as const),
    /** 2 is a double click, 3 selects a line. */
    times: Schema.Literals([1, 2, 3] as const),
  },
  Move: { to: ScreenPoint },
  Drag: { from: ScreenPoint, to: ScreenPoint },
  Scroll: { at: ScreenPoint, direction: ScrollDirection, notches: Notches },
  Type: { text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4000)) },
  /** A key or a chord, written the way a person says it: "Enter", "ctrl+c", "alt+Tab". */
  Press: { keys: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)) },
  Wait: { seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })) },
})
export type DesktopAction = typeof DesktopAction.Type

export const UseDesktopRequest = Schema.Struct({
  action: DesktopAction,
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})
export interface UseDesktopRequest extends Schema.Schema.Type<typeof UseDesktopRequest> {}

/**
 * The screen after the action. The picture is a PNG of the whole desktop, base64 on the wire; it
 * is shown to the model as an image and to nobody as text.
 */
export const DesktopView = Schema.Struct({
  picture: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  pointer: ScreenPoint,
  /** The title of the window that has the keyboard, when there is one. */
  window: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'DesktopView', title: 'Desktop view' })
export interface DesktopView extends Schema.Schema.Type<typeof DesktopView> {}

/** What came of a command: its result, a decision to wait for, a rule that forbids it, or no machine. */
export const CommandOutcome = Schema.TaggedUnion({
  Completed: { result: CommandResult },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String },
  /** A Person holds the Computer, or it is not running and could not be started. */
  Unavailable: { reason: Schema.String },
  /** Dispatch may have happened; a missing receipt never authorizes an automatic retry. */
  OutcomeUnknown: {},
})
export type CommandOutcome = typeof CommandOutcome.Type

/** What came of a browser step, including uncertain dispatch. */
export const BrowseOutcome = Schema.TaggedUnion({
  Completed: { result: BrowseResult },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String },
  Unavailable: { reason: Schema.String },
  /** Dispatch may have happened; a missing receipt never authorizes an automatic retry. */
  OutcomeUnknown: {},
})
export type BrowseOutcome = typeof BrowseOutcome.Type

/** What came of a desktop action, including uncertain dispatch. */
export const DesktopOutcome = Schema.TaggedUnion({
  Completed: { view: DesktopView },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String },
  Unavailable: { reason: Schema.String },
  /** Dispatch may have happened; a missing receipt never authorizes an automatic retry. */
  OutcomeUnknown: {},
})
export type DesktopOutcome = typeof DesktopOutcome.Type

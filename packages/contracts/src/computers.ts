import { Effect, Schema } from 'effect'
import { ApprovalId, ComputerId, RunId, ThreadId } from './identity.js'

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

/** The model chooses a relationship, never a device or Computer identifier. */
export const BrowseTarget = Schema.TaggedUnion({ Vivid: {}, Person: {} })
export type BrowseTarget = typeof BrowseTarget.Type

/**
 * Stored Approvals written before the target existed decode onto Vivid's Computer. This default
 * belongs to persisted actions only; a call always names its target.
 */
export const DefaultBrowseTarget = BrowseTarget.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(BrowseTarget.cases.Vivid.make({}))),
  Schema.withConstructorDefault(Effect.succeed(BrowseTarget.cases.Vivid.make({}))),
)

export const BrowseRequest = Schema.Struct({
  target: BrowseTarget,
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
 * A Person's own computer, as the desktop app enrolled it. The identifier names the record and
 * nothing else: it carries no Person, and it is not proof of being that computer.
 */
export const DeviceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('DeviceId'))
export type DeviceId = typeof DeviceId.Type

/**
 * What one installed desktop app calls itself: a random value it creates once and keeps in its own
 * data directory. Presenting it is how a signed-in session shows it is that app and not a browser
 * tab or a phone, so the server never sends it back to anyone.
 *
 * Adapted from the reference desktop app's installation file
 * (artifacts/night/reviews/chatgpt-latest.md, section 1, "Local PC used by the dot").
 */
export const InstallationId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('InstallationId'),
)
export type InstallationId = typeof InstallationId.Type

/** The computer's host name as its desktop app reported it, cut to what a list can show. */
export const DeviceName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100))
export type DeviceName = typeof DeviceName.Type

/**
 * Whether the Person lets Vivid use this computer. Enrolling never grants anything: a computer
 * waits as `Pending` until its Person allows it, and at most one of a Person's computers is
 * `Allowed` at a time. `since` is epoch milliseconds for the moment that state began.
 */
export const DeviceAccess = Schema.TaggedUnion({
  Pending: { since: Schema.Number },
  Allowed: { since: Schema.Number },
  Revoked: { since: Schema.Number },
})
export type DeviceAccess = typeof DeviceAccess.Type

/** Whether the computer's desktop app is listening right now. Never stored: it is the live link. */
export const DevicePresence = Schema.TaggedUnion({ Connected: {}, Offline: {} })
export type DevicePresence = typeof DevicePresence.Type

/**
 * One of a Person's own computers, as every surface lists it.
 *
 * Adapted from the reference's list of a Person's computers: a name, whether it is attached and
 * whether it is connected (artifacts/night/reviews/chatgpt-latest.md, section 4, "Computers list").
 */
export const Device = Schema.Struct({
  id: DeviceId,
  name: DeviceName,
  access: DeviceAccess,
  presence: DevicePresence,
}).annotate({ identifier: 'Device', title: 'Device' })
export interface Device extends Schema.Schema.Type<typeof Device> {}

export const DeviceResponse = Schema.Struct({ device: Device })
export const DeviceListResponse = Schema.Struct({ devices: Schema.Array(Device) })

/** What the desktop app sends once it is signed in. Repeating it changes nothing. */
export const EnrolDeviceRequest = Schema.Struct({ installation: InstallationId, name: DeviceName })
export interface EnrolDeviceRequest extends Schema.Schema.Type<typeof EnrolDeviceRequest> {}

/** Names the record and proves the caller is the app that enrolled it. */
export const WatchDeviceRequestsRequest = Schema.Struct({
  device: DeviceId,
  installation: InstallationId,
})
export interface WatchDeviceRequestsRequest extends Schema.Schema.Type<
  typeof WatchDeviceRequestsRequest
> {}

/** An opaque dispatch capability; it never appears in model-visible results. */
export const DeviceRequestId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('DeviceRequestId'),
)
export type DeviceRequestId = typeof DeviceRequestId.Type

/**
 * One action for the Person's computer. The Thread and the Run say what is driving it, so the
 * desktop app can show that and stop it; the deadline is authority to act once, not an invitation
 * to replay after a reconnect.
 */
export const DeviceRequest = Schema.Struct({
  id: DeviceRequestId,
  threadId: ThreadId,
  runId: RunId,
  action: BrowserAction,
  expiresAt: Schema.Number.check(Schema.isFinite()),
})
export interface DeviceRequest extends Schema.Schema.Type<typeof DeviceRequest> {}

/** Why the computer would not act. Closed reasons; page and browser details stay on the computer. */
export const DeviceRefusal = Schema.Literals(['Stopped', 'PageGone', 'NotAllowed', 'Unsupported'])
export type DeviceRefusal = typeof DeviceRefusal.Type

export const DeviceAnswer = Schema.TaggedUnion({
  Done: { result: BrowseResult },
  Refused: { reason: DeviceRefusal },
  Failed: {},
})
export type DeviceAnswer = typeof DeviceAnswer.Type

export const AnswerDeviceRequest = Schema.Struct({
  device: DeviceId,
  id: DeviceRequestId,
  answer: DeviceAnswer,
})
export interface AnswerDeviceRequest extends Schema.Schema.Type<typeof AnswerDeviceRequest> {}

/**
 * The Person has no allowed computer listening. Vivid's own Computer is never used instead: it is
 * a different machine with different sign-ins.
 */
export class NoDeviceConnected extends Schema.TaggedError<NoDeviceConnected>()(
  'NoDeviceConnected',
  {},
  { title: 'The Person’s computer is not connected' },
) {}

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

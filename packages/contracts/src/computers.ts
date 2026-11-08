import { Effect, Schema } from 'effect'
import { ApprovalId, ComputerId, RunId, ThreadId, ShellHandle } from './identity.js'
import { DeviceAbility, WindowAction, WindowRefusal, WindowResult } from './windows.js'
import { CopySignInRequest, SignInRead } from './signins.js'

/**
 * How a running Computer's screen is watched. `Relay` is a remote-framebuffer socket this server
 * relays, at a path on the app's own origin. `Viewer` is the machine provider's own viewer page
 * for this Person's machine: a short-lived permission, renewed before `expiresAt`, shown in a
 * sandboxed frame and never written down.
 */
export const ComputerScreen = Schema.TaggedUnion({
  Relay: { address: Schema.String },
  Viewer: { address: Schema.String, expiresAt: Schema.Finite },
})
export type ComputerScreen = typeof ComputerScreen.Type

/** The viewer always rechecks the signed-in Person; no provider URL, token or owner selector
 * travels in a Thread tool receipt. The enclosing submission supplies its Thread/Run linkage.
 */
export const computerScreenAddress = '/api/computer/screen/websockify'
export const ComputerSession = Schema.Struct({
  active: Schema.Literal(true),
  screen: ComputerScreen.cases.Relay,
})
export type ComputerSession = typeof ComputerSession.Type

/**
 * Where a Person's Computer stands. A Computer is created the first time it is needed and stopped
 * when idle; its files and sign-ins outlive the machine that held them.
 */
export const ComputerState = Schema.TaggedUnion({
  /** This Person has never needed one. */
  Absent: {},
  Starting: { since: Schema.Finite },
  Running: {
    since: Schema.Finite,
    screen: ComputerScreen,
  },
  Stopped: { since: Schema.Finite },
  Failed: { since: Schema.Finite, reason: Schema.String },
})
export type ComputerState = typeof ComputerState.Type

/** Lifecycle facts never issue a viewer permission or expose a provider identity. */
export const ComputerLifecycle = Schema.TaggedUnion({
  Absent: ComputerState.cases.Absent.fields,
  Starting: ComputerState.cases.Starting.fields,
  Running: { since: ComputerState.cases.Running.fields.since },
  Stopped: ComputerState.cases.Stopped.fields,
  Failed: ComputerState.cases.Failed.fields,
} satisfies Record<keyof typeof ComputerState.cases, Schema.Struct.Fields>)
export type ComputerLifecycle = typeof ComputerLifecycle.Type

/** Closed failures let recovery select a component without parsing a diagnostic sentence. */
export const ComputerProbeFailure = Schema.TaggedUnion({
  ProviderUnreachable: {},
  ProviderAuthentication: {},
  ProviderCapacity: {},
  ProviderStartLimit: {},
  ProviderOutgrown: { upgrade: Schema.Boolean },
  ProviderStalled: {},
  ProviderRefused: {},
  /** A persisted lifecycle failure whose original typed receipt is no longer available. */
  RecordedFailure: {},
  BindingUnresolved: {},
  SshUnreachable: {},
  SshAuthentication: {},
  SshHostMismatch: {},
  ReceiptLost: {},
  DiskFull: {},
  InodesFull: {},
  DesktopSession: {},
  DriverUnresponsive: {},
  BrowserUnresponsive: {},
  BrowserAmbiguous: {},
  BrowserPermission: {},
  Network: {},
  InvalidObservation: {},
})
export type ComputerProbeFailure = typeof ComputerProbeFailure.Type

/** Probe observations contain quantities and component facts, never private pages or environment. */
export const ComputerProbeObservation = Schema.TaggedUnion({
  Responsive: {},
  Disk: {
    volumes: Schema.Array(
      Schema.Struct({
        path: Schema.Literals(['/', 'home']),
        availableBytes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        availableInodes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  },
  Network: { clockOffsetMillis: Schema.Finite, uncertaintyMillis: Schema.Finite },
})
export const ComputerProbeResult = Schema.TaggedUnion({
  Passed: { observed: ComputerProbeObservation },
  Failed: { failure: ComputerProbeFailure },
  NotRun: {
    reason: Schema.Literals(['Shallow', 'UpstreamUnavailable', 'BrowserNotStarted', 'Unsupported']),
  },
})
export const ComputerProbe = Schema.Struct({
  component: Schema.Literals([
    'Provider',
    'Ssh',
    'Disk',
    'Desktop',
    'Driver',
    'Browser',
    'Network',
  ]),
  result: ComputerProbeResult,
})
export type ComputerProbe = typeof ComputerProbe.Type
export const ComputerHealthDepth = Schema.Literals(['Shallow', 'Deep'])
export type ComputerHealthDepth = typeof ComputerHealthDepth.Type
const checkedAt = Schema.Finite
const Probes = Schema.Array(ComputerProbe)
/** Ready certifies the requested depth only. Deep Ready requires every component, with an
 * unopened browser the only permissible NotRun. Degraded always has an observed failure. */
const Health = Schema.TaggedUnion({
  Absent: { checkedAt },
  Sleeping: { checkedAt },
  Starting: { checkedAt, since: Schema.Finite },
  Held: { checkedAt },
  Ready: { checkedAt, depth: ComputerHealthDepth, probes: Probes },
  Degraded: { checkedAt, probes: Probes },
  Unavailable: { checkedAt, cause: ComputerProbeFailure },
})
export const ComputerHealth = Health.check(
  Schema.makeFilter((health) =>
    Health.match(health, {
      Absent: () => true,
      Sleeping: () => true,
      Starting: () => true,
      Held: () => true,
      Unavailable: () => true,
      Degraded: ({ probes }) =>
        probes.some((probe) => ComputerProbeResult.guards.Failed(probe.result)),
      Ready: ({ depth, probes }) => {
        const required =
          depth === 'Shallow' ? ['Provider'] : ComputerProbe.fields.component.literals
        return (
          probes.length === required.length &&
          required.every((component) =>
            probes.some(
              (probe) =>
                probe.component === component &&
                (ComputerProbeResult.guards.Passed(probe.result) ||
                  (component === 'Browser' &&
                    ComputerProbeResult.guards.NotRun(probe.result) &&
                    probe.result.reason === 'BrowserNotStarted')),
            ),
          )
        )
      },
    }),
  ),
)
export type ComputerHealth = typeof ComputerHealth.Type

/** One explicit recovery request takes one step. Restore has no supported provider contract. */
export const ComputerRecoveryStep = Schema.Literals([
  'Wake',
  'Reconnect',
  'RestartBrowser',
  'RestartDriver',
  'RestartDesktop',
  'Reboot',
  'Restore',
])
export type ComputerRecoveryStep = typeof ComputerRecoveryStep.Type
export const ComputerRecoveryId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ComputerRecoveryId'),
)
export type ComputerRecoveryId = typeof ComputerRecoveryId.Type
export const ComputerRecoveryRefusal = Schema.TaggedUnion({
  Held: {},
  RunRequired: {},
  Busy: {},
  WrongStep: {},
  KeyReused: {},
  Unavailable: { cause: ComputerProbeFailure },
})
/** A persisted dispatch with no completion receipt is never replayed. */
export const ComputerRecoveryOutcome = Schema.TaggedUnion({
  Completed: { receipt: ComputerRecoveryId, health: ComputerHealth },
  Refused: { cause: ComputerRecoveryRefusal },
  PersonRequired: { step: ComputerRecoveryStep, consequence: Schema.String },
  Unsupported: { step: ComputerRecoveryStep, reason: Schema.String },
  OutcomeUnknown: { receipt: ComputerRecoveryId },
})
export type ComputerRecoveryOutcome = typeof ComputerRecoveryOutcome.Type
export const GetComputerHealthRequest = Schema.Struct({ depth: ComputerHealthDepth })
export type GetComputerHealthRequest = typeof GetComputerHealthRequest.Type
export const RecoverComputerRequest = Schema.Struct({
  id: ComputerRecoveryId,
  step: ComputerRecoveryStep,
})
export type RecoverComputerRequest = typeof RecoverComputerRequest.Type

export const Computer = Schema.Struct({
  id: Schema.NullOr(ComputerId),
  state: ComputerState,
  /** Whether a Person, rather than Vivid, currently holds the keyboard and pointer. */
  heldByPerson: Schema.Boolean,
}).annotate({ identifier: 'Computer', title: 'Computer' })
export interface Computer extends Schema.Schema.Type<typeof Computer> {}

export const ComputerResponse = Schema.Struct({ computer: Computer })

/**
 * Vivid's own use of its Computer's shell and files, as a person uses their machine. These carry
 * no summary and no approval: the Person allowed Vivid its Computer, and what Vivid does there is
 * not asked about. The acting Person comes from the call's authority, never from these fields.
 */
/** Absolute: the machine has no "current directory" between calls, so a relative path has no meaning. */
export const ComputerPath = Schema.String.check(Schema.isPattern(/^\//u), Schema.isMaxLength(4096))

/** A command in a directory. The deadline is the caller's; the machine ends the command at it. */
export const ComputerShellRequest = Schema.Struct({
  command: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
  directory: ComputerPath,
  timeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
})
export interface ComputerShellRequest extends Schema.Schema.Type<typeof ComputerShellRequest> {}

/** `Unavailable` is the Computer not being usable now (asleep and not waking, held by the
 * Person, the provider not answering), in a sentence Vivid can read. */
export const ComputerShellOutcome = Schema.TaggedUnion({
  /** `exitCode` is absent when the command was ended at its deadline or by a signal. */
  Completed: {
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    /** Only the end of an output stream was kept. */
    truncated: Schema.Boolean,
  },
  Unavailable: { reason: Schema.String },
  /** The connection went while the command ran: it may have run, and is not run again. */
  OutcomeUnknown: {},
})
export type ComputerShellOutcome = typeof ComputerShellOutcome.Type

export const ComputerFileReadRequest = Schema.Struct({ path: ComputerPath })
export interface ComputerFileReadRequest extends Schema.Schema.Type<
  typeof ComputerFileReadRequest
> {}

/** A whole file as its bytes; text is the reader's decision. */
export const ComputerFileReadOutcome = Schema.TaggedUnion({
  Read: { content: Schema.Uint8ArrayFromBase64 },
  /** The machine answered no: there is no such file, it is a directory, it is too large. */
  Refused: { reason: Schema.String },
  Unavailable: { reason: Schema.String },
})
export type ComputerFileReadOutcome = typeof ComputerFileReadOutcome.Type

export const ComputerFileWriteRequest = Schema.Struct({
  path: ComputerPath,
  content: Schema.Uint8ArrayFromBase64,
})
export interface ComputerFileWriteRequest extends Schema.Schema.Type<
  typeof ComputerFileWriteRequest
> {}

export const ComputerFileWriteOutcome = Schema.TaggedUnion({
  Written: {},
  Refused: { reason: Schema.String },
  Unavailable: { reason: Schema.String },
})
export type ComputerFileWriteOutcome = typeof ComputerFileWriteOutcome.Type

/** What the command produced. Long output is cut with a marker, never silently. */
export const CommandResult = Schema.Struct({
  exitCode: Schema.Finite,
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

/** 8 MiB encoded (about 6 MiB binary) caps one device answer before image/history retention. */
export const MAX_BROWSER_PICTURE_ENCODED_LENGTH = 8 * 1024 * 1024

/** Base64 PNG bytes, never a data URL or an arbitrary text receipt. The PNG signature and base64
 * alphabet identify the representation; actual image decoding belongs to the consuming renderer. */
export const BrowserPicture = Schema.String.check(
  Schema.isMaxLength(MAX_BROWSER_PICTURE_ENCODED_LENGTH),
  Schema.isPattern(/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u),
).pipe(Schema.brand('BrowserPicture'))
export type BrowserPicture = typeof BrowserPicture.Type

/** What the page looks like after the action: its address, title, readable outline and the tabs. */
export const BrowseResult = Schema.Struct({
  address: Schema.String,
  title: Schema.String,
  outline: Schema.String,
  /** Optional image attachment, orthogonal to page metadata. Its absence is genuine: a result
   * still describes the same page without an attachment, rather than a second page state. */
  picture: Schema.optionalKey(BrowserPicture),
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
 * waits as `Pending` until its Person explicitly allows or denies it, even while offline or
 * after a server restart. At most one personal computer is `Allowed` at a time.
 * `since` is epoch milliseconds for the moment that state began.
 */
export const DeviceAccess = Schema.TaggedUnion({
  Pending: { since: Schema.Finite },
  Allowed: { since: Schema.Finite },
  Revoked: { since: Schema.Finite },
})
export type DeviceAccess = typeof DeviceAccess.Type

/**
 * Whether the computer's desktop app is listening right now, and what that app can do. Never
 * stored: it is the live link, and `ability` is what the app said when it started listening.
 */
export const DevicePresence = Schema.TaggedUnion({
  Connected: { ability: DeviceAbility },
  Offline: {},
})
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

/**
 * The Person's personal computers. `DeviceAccess.Pending` is the durable outstanding request;
 * presence describes connectivity only and never changes whether a decision is owed.
 */
export const DeviceListResponse = Schema.Struct({
  devices: Schema.Array(Device),
  /** Installed OTA bundles require this field; every Pending device asks until explicitly decided. */
  asking: Schema.Array(DeviceId),
})

/** What the desktop app sends once it is signed in. Repeating it changes nothing. */
export const EnrolDeviceRequest = Schema.Struct({ installation: InstallationId, name: DeviceName })
export interface EnrolDeviceRequest extends Schema.Schema.Type<typeof EnrolDeviceRequest> {}

/** Names the record and proves the caller is the app that enrolled it. */
export const WatchDeviceRequestsRequest = Schema.Struct({
  device: DeviceId,
  installation: InstallationId,
  /** What this app can do right now; the server offers it no work it cannot do. */
  ability: DeviceAbility,
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
 * The work a Device is asked to do: a step in a page of the desktop app's own browser, or an
 * action in an app on the computer.
 */
export const DeviceWork = Schema.TaggedUnion({
  Page: { action: BrowserAction },
  Window: { action: WindowAction },
  SignIn: CopySignInRequest.fields,
})
export type DeviceWork = typeof DeviceWork.Type

/**
 * What the server says to a listening desktop app.
 *
 * - `Act`: one piece of work. The Thread and the Run say what is driving it, so the desktop app
 *   can show that and stop it; the deadline is authority to act once, not an invitation to replay
 *   after a reconnect. Work in an app belongs to a turn that lasts as long as its Run: the
 *   desktop app begins the turn at the first `Window` work of a Run and shows its notice.
 * - `RunEnded`: that Run is over, however it ended. The desktop app ends the turn and takes the
 *   notice down. Without it the notice stayed until a timeout, saying Vivid was using a computer
 *   it had finished with.
 */
export const DeviceRequest = Schema.TaggedUnion({
  Act: {
    id: DeviceRequestId,
    threadId: ThreadId,
    runId: RunId,
    work: DeviceWork,
    expiresAt: Schema.Number.check(Schema.isFinite()),
  },
  RunEnded: { runId: RunId },
})
export type DeviceRequest = typeof DeviceRequest.Type

/** Why the computer would not act. Closed reasons; page and browser details stay on the computer. */
export const DeviceRefusal = Schema.Literals(['Stopped', 'PageGone', 'NotAllowed', 'Unsupported'])
export type DeviceRefusal = typeof DeviceRefusal.Type

/**
 * `Done` and `Refused` answer work in a page; `Did` and `Declined` answer work in an app, whose
 * results and refusals are a different vocabulary (`WindowResult`, `WindowRefusal`). `Failed` is
 * either kind going wrong on the computer with nothing more to say.
 */
export const DeviceAnswer = Schema.TaggedUnion({
  Done: { result: BrowseResult },
  Refused: { reason: DeviceRefusal },
  Did: { result: WindowResult },
  Declined: { reason: WindowRefusal },
  Failed: {},
  SignIn: { read: SignInRead },
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

/** What came of a browser step, including uncertain dispatch. */
export const BrowseOutcome = Schema.TaggedUnion({
  NotConnected: {},
  NotAllowed: {},
  /** The Device refused the page or address, independently of the Person’s access permission. */
  AddressRefused: {},
  Busy: {},
  Stopped: {},
  PageGone: {},
  Unsupported: {},
  RunRequired: {},
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

/**
 * The Person stopped Vivid on their computer (Escape, or Stop on the notice) with nothing in
 * flight to answer: between two actions of a Run. The desktop app says so at once, and the server
 * stops that Run, so Vivid does not send the next action into a turn that is over.
 */
export const ReportDeviceStopRequest = Schema.Struct({
  device: DeviceId,
  installation: InstallationId,
  runId: RunId,
})
export interface ReportDeviceStopRequest extends Schema.Schema.Type<
  typeof ReportDeviceStopRequest
> {}

export const StartShellRequest = Schema.Struct({
  command: ComputerShellRequest.fields.command,
  directory: ComputerPath,
})
export type StartShellRequest = typeof StartShellRequest.Type
export const ReadShellRequest = Schema.Struct({ handle: ShellHandle })
export type ReadShellRequest = typeof ReadShellRequest.Type
export const WaitShellRequest = Schema.Struct({
  handle: ShellHandle,
  seconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 })),
})
export type WaitShellRequest = typeof WaitShellRequest.Type
const shellOutput = {
  handle: ShellHandle,
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  outputDirectory: ComputerPath,
}
/** Running snapshots remain readable; terminal states never invent an exit status. */
export const ShellSnapshot = Schema.TaggedUnion({
  Queued: { handle: ShellHandle },
  Running: shellOutput,
  Completed: { ...shellOutput, exitCode: Schema.Int },
  Stopped: shellOutput,
  Unknown: shellOutput,
  Missing: {},
  Unavailable: { reason: Schema.String },
})
export type ShellSnapshot = typeof ShellSnapshot.Type

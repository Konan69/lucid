import type * as NodeStream from 'node:stream'
import {
  type BrowseResult,
  type BrowserAction,
  type CommandResult,
  type DesktopAction,
  type DesktopView,
  ComputerState,
} from '@vivid/contracts'
import { Context, type Effect, type Redacted, Schema, type Scope, type Stream } from 'effect'

/** App-owned RFB transport path; neither provider locations nor credentials belong in Running state. */
export { computerScreenAddress } from '@vivid/contracts'

/** Opaque provider identity; the caller derives it without exposing a Person's identity. */
export const MachineKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)).pipe(
  Schema.brand('MachineKey'),
)
export type MachineKey = typeof MachineKey.Type

/** Private screen authority: the credential never enters a wire schema, URL, log, or client. */
export interface MachineScreen {
  readonly address: string
  readonly authorization: Redacted.Redacted
}

/** Lifecycle observation carries no viewer authority; Vivid never needs a screen permission to act. */
const lifecycleStates = {
  Absent: ComputerState.cases.Absent.fields,
  Starting: ComputerState.cases.Starting.fields,
  Running: { since: ComputerState.cases.Running.fields.since },
  Stopped: ComputerState.cases.Stopped.fields,
  Failed: ComputerState.cases.Failed.fields,
} satisfies Record<keyof typeof ComputerState.cases, Schema.Struct.Fields>
export const MachineState = Schema.TaggedUnion(lifecycleStates)
export type MachineState = typeof MachineState.Type

/** A command or browser step cannot run against an absent or stopped machine. */
export class MachineNotRunning extends Schema.TaggedError<MachineNotRunning>()(
  'MachineNotRunning',
  { key: MachineKey },
  { title: 'MachineNotRunning' },
) {}

/** Provider failure carries bounded operation context, never CLI arguments or output. */
export class MachineOperationFailed extends Schema.TaggedError<MachineOperationFailed>()(
  'MachineOperationFailed',
  { operation: Schema.String },
  { title: 'MachineOperationFailed' },
) {}

/**
 * The provider did not answer: the connection failed or no reply came in time. Nothing is learned
 * about the machine. This is an outage, not a refusal, and it ends by itself: every call dials the
 * provider afresh, so the next one works as soon as the provider answers again.
 */
export class MachineUnreachable extends Schema.TaggedError<MachineUnreachable>()(
  'MachineUnreachable',
  {},
  { title: 'MachineUnreachable' },
) {}

/** The provider kept reporting the same lifecycle state without progress. The binding stays
 * authoritative, and a later call reconciles this machine instead of creating a replacement. */
export class MachineLifecycleStalled extends Schema.TaggedError<MachineLifecycleStalled>()(
  'MachineLifecycleStalled',
  { key: MachineKey },
  { title: 'Computer lifecycle stopped progressing' },
) {}

/** A lost command receipt is uncertain: the provider must not authorize an automatic retry. */
export class MachineExecutionUnknown extends Schema.TaggedError<MachineExecutionUnknown>()(
  'MachineExecutionUnknown',
  { key: MachineKey },
  { title: 'MachineExecutionUnknown' },
) {}

/** A malformed provider response must not become invented machine facts. */
export class MachineResponseInvalid extends Schema.TaggedError<MachineResponseInvalid>()(
  'MachineResponseInvalid',
  { operation: Schema.String },
  { title: 'MachineResponseInvalid' },
) {}

/** Trusted callers must still supply bounded command execution parameters. */
export class MachineInputInvalid extends Schema.TaggedError<MachineInputInvalid>()(
  'MachineInputInvalid',
  {},
  { title: 'MachineInputInvalid' },
) {}

/** Navigation is restricted before invoking the browser, independently of network enforcement. */
export class BrowserAddressRefused extends Schema.TaggedError<BrowserAddressRefused>()(
  'BrowserAddressRefused',
  {},
  { title: 'BrowserAddressRefused' },
) {}

/** Browser failures do not expose page text, typed credentials, or driver arguments. */
export class BrowserStepFailed extends Schema.TaggedError<BrowserStepFailed>()(
  'BrowserStepFailed',
  {},
  { title: 'BrowserStepFailed' },
) {}

/**
 * The provider refused the server's credential. The key is present (the server does not start
 * without it), so this is a revoked or wrong key, never a retryable machine operation.
 */
export class MachineAuthenticationFailed extends Schema.TaggedError<MachineAuthenticationFailed>()(
  'MachineAuthenticationFailed',
  {},
  { title: 'MachineAuthenticationFailed' },
) {}

/** An unbound create past Boat's idempotency window needs reconciliation, never another billable create. */
export class MachineCreationUnresolved extends Schema.TaggedError<MachineCreationUnresolved>()(
  'MachineCreationUnresolved',
  { key: MachineKey },
  { title: 'MachineCreationUnresolved' },
) {}

/** Provider refusals preserve only HTTP status; bodies can contain private commands or credentials. */
export class MachineRequestRejected extends Schema.TaggedError<MachineRequestRejected>()(
  'MachineRequestRejected',
  { status: Schema.Int },
  { title: 'MachineRequestRejected' },
) {}

/**
 * The provider answered that it will not start this Computer now, though it could hold it: it has
 * no machine free on any size the start may use, or (`limited`) the installation has used up the
 * number of starts the provider allows in an hour. Nothing was started and the Computer is as it
 * was: stopped, with its disk saved. It is not an outage (the provider answered) and not a fault
 * of the machine, and it ends by itself, so the next start is simply tried afresh.
 */
export class MachineNoCapacity extends Schema.TaggedError<MachineNoCapacity>()(
  'MachineNoCapacity',
  { limited: Schema.Boolean },
  { title: 'MachineNoCapacity' },
) {}

/**
 * The Computer holds more data than any machine the provider will start it on.
 *
 * Nothing was started and nothing is lost: the disk is saved as it was. It does not end by itself
 * the way `MachineNoCapacity` does. It ends when files are removed from the Computer, or when
 * the installation's provider plan allows a larger machine: `upgrade` says the provider named a
 * larger size and refused it for the plan. On 7 October 2026 a Person's Computer needed 125.4 GiB
 * where the plan's largest machine held 125.0, and all Vivid could say was that the provider
 * "refused the operation": nobody could tell that the cure was a plan or a clean disk.
 */
export class MachineOutgrown extends Schema.TaggedError<MachineOutgrown>()(
  'MachineOutgrown',
  { upgrade: Schema.Boolean },
  { title: 'MachineOutgrown' },
) {}

/** An installation's adopted Computer has one owner; refusal never reveals that Person's identity. */
export class MachineHeld extends Schema.TaggedError<MachineHeld>()(
  'MachineHeld',
  {},
  { title: 'MachineHeld' },
) {}

/** File persistence is required before provisioning and cannot be replaced by an in-memory binding. */
export class MachinePersistenceFailed extends Schema.TaggedError<MachinePersistenceFailed>()(
  'MachinePersistenceFailed',
  {},
  { title: 'MachinePersistenceFailed' },
) {}

/** Unsupported provider capabilities are explicit; Boat uses its native viewer rather than RFB relay. */
export class MachineCapabilityUnavailable extends Schema.TaggedError<MachineCapabilityUnavailable>()(
  'MachineCapabilityUnavailable',
  { capability: Schema.Literals(['relay', 'desktop', 'browser']) },
  { title: 'MachineCapabilityUnavailable' },
) {}

/**
 * The machine's file system answered a read or a write with a refusal: the file is not there, is
 * a directory, may not be touched, or is larger than one call carries. The machine is fine.
 */
export const MachineFileReason = Schema.Literals([
  'missing',
  'denied',
  'directory',
  'large',
  'other',
])
export class MachineFileRefused extends Schema.TaggedError<MachineFileRefused>()(
  'MachineFileRefused',
  { reason: MachineFileReason },
  { title: 'MachineFileRefused' },
) {}

/**
 * Nothing on the machine listens on the loopback port that was asked for. The machine is fine.
 * Only `tunnel` meets it, so it is that call's own failure and not one of `MachineFailure`.
 */
export class MachinePortClosed extends Schema.TaggedError<MachinePortClosed>()(
  'MachinePortClosed',
  { port: Schema.Int },
  { title: 'MachinePortClosed' },
) {}

/**
 * Precise adapter failures remain visible for orchestration and RPC translation.
 *
 * None of them says "no provider is configured". A server always has its Computer provider: its
 * settings are required when the server is composed (`boat/transport.ts`), so a missing one is a
 * server that did not start. What is left here is what can go wrong on a call while the provider
 * is configured, and each call is tried afresh, so an outage ends when the provider answers again.
 */
export type MachineFailure =
  | MachineNotRunning
  | MachineOperationFailed
  | MachineLifecycleStalled
  | MachineUnreachable
  | MachineExecutionUnknown
  | MachineResponseInvalid
  | MachineInputInvalid
  | BrowserAddressRefused
  | BrowserStepFailed
  | MachineAuthenticationFailed
  | MachineCreationUnresolved
  | MachineRequestRejected
  | MachineNoCapacity
  | MachineOutgrown
  | MachinePersistenceFailed
  | MachineHeld
  | MachineCapabilityUnavailable
  | MachineFileRefused

/**
 * What a followed command says while it runs, and how it ended.
 *
 * `Printed` is text in the order it was written; one piece is not one line. `Exited` is the last
 * thing a stream carries. `memory` is the provider saying it ended the command for memory, which
 * an exit code alone does not tell apart from any other kill.
 */
export const MachineOutput = Schema.TaggedUnion({
  Printed: { text: Schema.String },
  Exited: {
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    memory: Schema.Boolean,
  },
})
export type MachineOutput = typeof MachineOutput.Type

/**
 * How a command on the machine ended, with what it printed on each stream. `exitCode` is absent
 * when the command was ended at its deadline (`timedOut`) or by a signal. `truncated` says only
 * the end of a stream was kept.
 */
export interface MachineRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly truncated: boolean
}

/**
 * Whether a failure says the provider could not be asked, as opposed to what it answered: no
 * connection, no reply in time, or the provider's own 5xx. Such a failure is no evidence about the
 * machine, so callers tell it on the call that met it and never record it as the machine's state.
 */
export const isOutage = (failure: MachineFailure): boolean =>
  failure instanceof MachineUnreachable ||
  (failure instanceof MachineRequestRejected && failure.status >= 500)

/**
 * Failures that asking again does not cure: something outside Vivid has to change first (files
 * removed or a larger plan, the machine's holder, the provider's credentials, an unresolved
 * creation). Everything else a start can meet is worth asking again at the next need.
 *
 * The difference matters because every start is counted: Boat allows an account 25 starts an hour
 * across all its machines and answered 429 `rate_limited` on 7 October 2026, after a day of
 * starts that could not succeed had spent them.
 */
export const isStanding = (failure: MachineFailure): boolean =>
  failure instanceof MachineOutgrown ||
  failure instanceof MachineHeld ||
  failure instanceof MachineAuthenticationFailed ||
  failure instanceof MachineCreationUnresolved

/**
 * A command on the machine that is spoken with while it runs, over the machine's SSH connection
 * (`ssh/link.ts`, `LinkConversation`): what it prints arrives as it prints, and text can be
 * written to its standard input. This is how a program on the Computer and the server talk.
 */
export interface MachineConversation {
  /** Standard output as text, in the pieces it arrives in; ends when the command ends. */
  readonly output: Stream.Stream<string, MachineFailure>
  readonly say: (text: string) => Effect.Effect<void, MachineFailure>
  /** How the command ended. `timedOut` is the machine's own deadline for it. */
  readonly ended: Effect.Effect<
    { readonly exitCode: number | null; readonly timedOut: boolean },
    MachineFailure
  >
}

/** One machine boundary; ownership, approvals, receipts, and RPC remain application concerns. */
export interface MachineOperations {
  /** Import into the same Chrome profile as browser work. Values stay on the private channel. */
  readonly copySignIn: (input: {
    readonly key: MachineKey
    readonly egress: boolean
    readonly cookies: ReadonlyArray<import('@vivid/contracts').SignInCookie>
  }) => Effect.Effect<number, MachineFailure>
  readonly ensure: (
    key: MachineKey,
  ) => Effect.Effect<typeof MachineState.cases.Running.Type, MachineFailure>
  readonly stop: (key: MachineKey) => Effect.Effect<void, MachineFailure>
  readonly screen: (key: MachineKey) => Effect.Effect<MachineScreen, MachineFailure>
  readonly inspect: (key: MachineKey) => Effect.Effect<MachineState, MachineFailure>
  readonly status: (key: MachineKey) => Effect.Effect<ComputerState, MachineFailure>
  readonly exec: (input: {
    readonly key: MachineKey
    readonly command: string
    readonly timeoutSeconds: number
  }) => Effect.Effect<CommandResult, MachineFailure>
  /**
   * Starts a command and reports what it prints while it runs; the stream ends with one `Exited`.
   * `exec` answers only when the command is over, which cannot carry a program that asks for
   * things as it goes. A followed command does not hold the machine: the actions it asks for
   * (a command, a browser step) run beside it.
   */
  readonly follow: (input: {
    readonly key: MachineKey
    readonly command: string
    readonly timeoutSeconds: number
  }) => Stream.Stream<MachineOutput, MachineFailure>
  /** Puts a text file on the machine and creates its directories. A relative path is under the
   * directory commands start in. */
  readonly write: (input: {
    readonly key: MachineKey
    readonly path: string
    readonly content: string
  }) => Effect.Effect<void, MachineFailure>
  /**
   * The machine's own shell and files, over its SSH connection (`ssh/link.ts`). These are what a
   * person at the machine has: a command with both output streams and its exit code, in a
   * directory, and whole files as bytes. `exec`, `follow` and `write` above go through the
   * provider's API and stay until this path has run on a Person's Computer; then they move here.
   */
  readonly run: (input: {
    readonly key: MachineKey
    readonly command: string
    readonly directory: string
    readonly timeoutSeconds: number | null
  }) => Effect.Effect<MachineRun, MachineFailure>
  /**
   * Starts a command and holds it for the scope; closing the scope ends it. Unlike `follow`, it
   * can be written to, so nothing has to be put on the machine's disk to answer it.
   */
  readonly converse: (input: {
    readonly key: MachineKey
    readonly command: string
    readonly directory: string
    readonly timeoutSeconds: number | null
  }) => Effect.Effect<MachineConversation, MachineFailure, Scope.Scope>
  /**
   * A byte stream to a port on the machine's own loopback, over its SSH connection, held for the
   * scope (`ssh/link.ts`, `tunnel`). It never wakes a machine: one that is not running is
   * `MachineNotRunning`, and a port nothing listens on is `MachinePortClosed`.
   */
  readonly tunnel: (input: {
    readonly key: MachineKey
    readonly port: number
  }) => Effect.Effect<NodeStream.Duplex, MachineFailure | MachinePortClosed, Scope.Scope>
  readonly read: (input: {
    readonly key: MachineKey
    readonly path: string
  }) => Effect.Effect<Uint8Array, MachineFailure>
  /** Replaces the file and creates the directories above it. */
  readonly put: (input: {
    readonly key: MachineKey
    readonly path: string
    readonly content: Uint8Array
  }) => Effect.Effect<void, MachineFailure>
  /**
   * One step in the Computer's browser. `egress` is the Person's choice to send the browser's
   * traffic out through their own computer (`egress/`): it matters only when this step has to
   * start the browser, which is then started with the Computer's egress proxy as its proxy. A
   * browser that is already running keeps the way out it was started with.
   */
  readonly browse: (input: {
    readonly key: MachineKey
    readonly action: BrowserAction
    readonly egress: boolean
  }) => Effect.Effect<BrowseResult, MachineFailure>
  readonly desktop: (input: {
    readonly key: MachineKey
    readonly action: DesktopAction
  }) => Effect.Effect<DesktopView, MachineFailure>
}

/** Authority over the machine provider, distinct from application ownership and approvals. */
export class Machine extends Context.Service<Machine, MachineOperations>()('vivid/Machine') {}

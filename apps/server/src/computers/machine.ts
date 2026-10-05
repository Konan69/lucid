import {
  type BrowseResult,
  type BrowserAction,
  type CommandResult,
  type DesktopAction,
  type DesktopView,
  ComputerState,
} from '@vivid/contracts'
import { Context, type Effect, Schema, type Redacted } from 'effect'

/** App-owned RFB transport path; neither provider locations nor credentials belong in Running state. */
export { computerScreenAddress } from '@vivid/contracts'

/** Opaque provider identity; the caller derives it without exposing a Person's identity. */
export const MachineKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)).pipe(
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
  | MachineUnreachable
  | MachineExecutionUnknown
  | MachineResponseInvalid
  | MachineInputInvalid
  | BrowserAddressRefused
  | BrowserStepFailed
  | MachineAuthenticationFailed
  | MachineCreationUnresolved
  | MachineRequestRejected
  | MachinePersistenceFailed
  | MachineHeld
  | MachineCapabilityUnavailable

/**
 * Whether a failure says the provider could not be asked, as opposed to what it answered: no
 * connection, no reply in time, or the provider's own 5xx. Such a failure is no evidence about the
 * machine, so callers tell it on the call that met it and never record it as the machine's state.
 */
export const isOutage = (failure: MachineFailure): boolean =>
  failure instanceof MachineUnreachable ||
  (failure instanceof MachineRequestRejected && failure.status >= 500)

/** One machine boundary; ownership, approvals, receipts, and RPC remain application concerns. */
export interface MachineOperations {
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
  readonly browse: (input: {
    readonly key: MachineKey
    readonly action: BrowserAction
  }) => Effect.Effect<BrowseResult, MachineFailure>
  readonly desktop: (input: {
    readonly key: MachineKey
    readonly action: DesktopAction
  }) => Effect.Effect<DesktopView, MachineFailure>
}

/** Authority over the machine provider, distinct from application ownership and approvals. */
export class Machine extends Context.Service<Machine, MachineOperations>()('vivid/Machine') {}

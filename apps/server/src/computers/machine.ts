import {
  type BrowseResult,
  type BrowserAction,
  type CommandResult,
  type DesktopAction,
  type DesktopView,
  ComputerState,
} from '@vivid/contracts'
import { Context, Effect, Layer, Schema, type Redacted } from 'effect'

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
  Unavailable: ComputerState.cases.Unavailable.fields,
} satisfies Record<keyof typeof ComputerState.cases, Schema.Struct.Fields>
export const MachineState = Schema.TaggedUnion(lifecycleStates)
export type MachineState = typeof MachineState.Type

/** Docker's healthy machine facts are also the transport's Running state. */
export type RunningMachine = typeof ComputerState.cases.Running.Type

/** Missing provider configuration is distinct from a failed configured provider. */
export class MachineUnavailable extends Schema.TaggedError<MachineUnavailable>()(
  'MachineUnavailable',
  {},
  { title: 'MachineUnavailable' },
) {}

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

/** Configuration failures carry no supplied values, including accidentally pasted credentials. */
export class MachineConfigurationInvalid extends Schema.TaggedError<MachineConfigurationInvalid>()(
  'MachineConfigurationInvalid',
  {},
  { title: 'MachineConfigurationInvalid' },
) {}

/** Provider authentication is configuration failure, not a retryable machine operation. */
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

/** File persistence is required before provisioning and cannot be replaced by an in-memory binding. */
export class MachinePersistenceFailed extends Schema.TaggedError<MachinePersistenceFailed>()(
  'MachinePersistenceFailed',
  {},
  { title: 'MachinePersistenceFailed' },
) {}

/** Unsupported local capabilities are explicit; the offline provider never imitates Boat results. */
export class MachineCapabilityUnavailable extends Schema.TaggedError<MachineCapabilityUnavailable>()(
  'MachineCapabilityUnavailable',
  { capability: Schema.Literals(['relay', 'desktop', 'browser']) },
  { title: 'MachineCapabilityUnavailable' },
) {}

/** Precise adapter failures remain visible for orchestration and RPC translation. */
export type MachineFailure =
  | MachineUnavailable
  | MachineNotRunning
  | MachineOperationFailed
  | MachineExecutionUnknown
  | MachineResponseInvalid
  | MachineInputInvalid
  | BrowserAddressRefused
  | BrowserStepFailed
  | MachineConfigurationInvalid
  | MachineAuthenticationFailed
  | MachineCreationUnresolved
  | MachineRequestRejected
  | MachinePersistenceFailed
  | MachineCapabilityUnavailable

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

/** Disabled installations report honest absence of provider authority on every operation. */
export const unavailableMachineLayer = Layer.effect(
  Machine,
  Effect.succeed(
    Machine.of({
      ensure: Effect.fn('Machine.unavailable.ensure')(() => Effect.fail(new MachineUnavailable())),
      stop: Effect.fn('Machine.unavailable.stop')(() => Effect.fail(new MachineUnavailable())),
      inspect: Effect.fn('Machine.unavailable.inspect')(() =>
        Effect.succeed(MachineState.cases.Unavailable.make({})),
      ),
      status: Effect.fn('Machine.unavailable.status')(() =>
        Effect.succeed(ComputerState.cases.Unavailable.make({})),
      ),
      screen: Effect.fn('Machine.unavailable.screen')(() => Effect.fail(new MachineUnavailable())),
      exec: Effect.fn('Machine.unavailable.exec')(() => Effect.fail(new MachineUnavailable())),
      browse: Effect.fn('Machine.unavailable.browse')(() => Effect.fail(new MachineUnavailable())),
      desktop: Effect.fn('Machine.unavailable.desktop')(() =>
        Effect.fail(new MachineUnavailable()),
      ),
    }),
  ),
)

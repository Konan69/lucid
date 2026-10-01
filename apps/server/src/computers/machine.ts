import {
  type BrowseResult,
  type BrowserAction,
  type CommandResult,
  ComputerState,
} from '@vivid/contracts'
import { Context, Effect, Layer, Schema, type Redacted } from 'effect'

/** App-owned RFB transport path; neither provider locations nor credentials belong in Running state. */
export const computerScreenAddress = '/api/computer/screen/websockify'

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

/** One machine boundary; ownership, approvals, receipts, and RPC remain application concerns. */
export interface MachineOperations {
  readonly ensure: (key: MachineKey) => Effect.Effect<RunningMachine, MachineFailure>
  readonly stop: (key: MachineKey) => Effect.Effect<void, MachineFailure>
  readonly screen: (key: MachineKey) => Effect.Effect<MachineScreen, MachineFailure>
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
      status: Effect.fn('Machine.unavailable.status')(() =>
        Effect.succeed(ComputerState.cases.Unavailable.make({})),
      ),
      screen: Effect.fn('Machine.unavailable.screen')(() => Effect.fail(new MachineUnavailable())),
      exec: Effect.fn('Machine.unavailable.exec')(() => Effect.fail(new MachineUnavailable())),
      browse: Effect.fn('Machine.unavailable.browse')(() => Effect.fail(new MachineUnavailable())),
    }),
  ),
)

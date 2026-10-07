import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ComputerId } from './manifest.ts'

/**
 * Whether a machine currently exists for this Computer. `Absent` is the normal resting state, not
 * a failure: an idle Person has an archive and no machine, which is what keeps idle cost at
 * storage.
 */
export const MachineState = Schema.TaggedUnion({
  Absent: {},
  Starting: {},
  Running: {
    /** Where a Person watches and takes over the desktop. Short-lived; never persist it. */
    desktopUrl: Schema.String,
  },
  Stopping: {},
})
export type MachineState = typeof MachineState.Type

/** The provider could not be reached, or refused for a reason unrelated to this Computer. */
export class MachineProviderUnavailable extends Schema.TaggedError<MachineProviderUnavailable>()(
  'MachineProviderUnavailable',
  { operation: Schema.String },
  { title: 'Machine provider unavailable' },
) {}

/** An operation needed a running machine and there is none. The caller decides whether to start one. */
export class MachineNotRunning extends Schema.TaggedError<MachineNotRunning>()(
  'MachineNotRunning',
  { computerId: ComputerId },
  { title: 'Machine not running' },
) {}

/** A command ran to completion on the machine and reported failure. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  'CommandFailed',
  {
    computerId: ComputerId,
    exitCode: Schema.Finite,
    stderr: Schema.String,
  },
  { title: 'Command failed' },
) {}

export interface MachineProviderService {
  readonly state: (
    computerId: ComputerId,
  ) => Effect.Effect<MachineState, MachineProviderUnavailable>
  /** Idempotent: returns the running machine, starting one only when the Computer has none. */
  readonly start: (
    computerId: ComputerId,
  ) => Effect.Effect<typeof MachineState.cases.Running.Type, MachineProviderUnavailable>
  /** Idempotent. The caller captures first; a stop never implies the state was saved. */
  readonly stop: (computerId: ComputerId) => Effect.Effect<void, MachineProviderUnavailable>
  readonly run: (input: {
    readonly computerId: ComputerId
    readonly command: ReadonlyArray<string>
  }) => Effect.Effect<
    { readonly stdout: string },
    MachineProviderUnavailable | MachineNotRunning | CommandFailed
  >
}

/**
 * The one seam between Vivid and whoever rents us machines. Nothing above it may name a provider.
 * It is deliberately small — state, start, stop, run — because everything durable goes through
 * `ComputerArchive` instead: a provider that loses a machine loses nothing a Person made. That
 * property is what makes the provider replaceable, so do not add provider-side persistence
 * (snapshots, volumes) to this interface.
 */
export class MachineProvider extends Context.Service<MachineProvider, MachineProviderService>()(
  'vivid/MachineProvider',
) {}

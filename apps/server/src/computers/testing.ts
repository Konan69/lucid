import { ComputerState } from '@vivid/contracts'
import { Effect, Layer, Stream } from 'effect'
import { Machine, MachineNotRunning, type MachineKey } from './machine.ts'

/**
 * A deliberate test Layer: a provider that holds no machine for anyone and cannot start one.
 *
 * It stands in for the provider in suites whose claims are about something else (screen sessions,
 * programs) and that must not reach Boat. Every observation answers `Absent`, and every operation
 * that needs a machine is refused with the provider's own "not running" failure. It is not a
 * production variant: a server always has its Computer provider (`boat/transport.ts`).
 */
export const absentMachineLayer = Layer.succeed(
  Machine,
  Machine.of({
    ensure: Effect.fn('Machine.absent.ensure')((key: MachineKey) =>
      Effect.fail(new MachineNotRunning({ key })),
    ),
    stop: Effect.fn('Machine.absent.stop')(() => Effect.void),
    inspect: Effect.fn('Machine.absent.inspect')(() =>
      Effect.succeed(ComputerState.cases.Absent.make({})),
    ),
    status: Effect.fn('Machine.absent.status')(() =>
      Effect.succeed(ComputerState.cases.Absent.make({})),
    ),
    screen: Effect.fn('Machine.absent.screen')((key: MachineKey) =>
      Effect.fail(new MachineNotRunning({ key })),
    ),
    exec: Effect.fn('Machine.absent.exec')(({ key }: { readonly key: MachineKey }) =>
      Effect.fail(new MachineNotRunning({ key })),
    ),
    follow: ({ key }: { readonly key: MachineKey }) => Stream.fail(new MachineNotRunning({ key })),
    write: Effect.fn('Machine.absent.write')(({ key }: { readonly key: MachineKey }) =>
      Effect.fail(new MachineNotRunning({ key })),
    ),
    browse: Effect.fn('Machine.absent.browse')(({ key }: { readonly key: MachineKey }) =>
      Effect.fail(new MachineNotRunning({ key })),
    ),
    desktop: Effect.fn('Machine.absent.desktop')(({ key }: { readonly key: MachineKey }) =>
      Effect.fail(new MachineNotRunning({ key })),
    ),
  }),
)

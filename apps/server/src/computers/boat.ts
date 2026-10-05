import { type BrowseResult } from '@vivid/contracts'
import { Effect, Layer, Option } from 'effect'
import {
  Machine,
  MachineCapabilityUnavailable,
  MachineHeld,
  MachineInputInvalid,
  MachinePersistenceFailed,
  MachineResponseInvalid,
  MachineOperationFailed,
  type MachineKey,
} from './machine.ts'
import { bindings } from './boat/bindings.ts'
import { transport } from './boat/transport.ts'
import type { Driver } from './boat/driver.ts'
import { guestDriver } from './boat/guest.ts'
import { desktopStep, look } from './boat/desktop.ts'
import { browse } from './boat/browser.ts'
import { lifecycle } from './boat/lifecycle.ts'
import { HELD, holdable, wakeCommand } from './boat/holder.ts'

/** Boat ships the desktop and Chrome; this Layer owns a pinned guest driver prerequisite.
 * Binding lookup is durable; only per-process serialization is cached. Viewer authority is
 * cached until sixty seconds before expiry and never persisted, logged or reused across Persons. */
export const boatMachineLayer = Layer.effect(
  Machine,
  Effect.gen(function* () {
    const api = yield* transport()
    const saved = yield* bindings()
    const drivers = new Map<MachineKey, { readonly native: Driver; readonly generation: string }>()
    const tabs = new Map<MachineKey, BrowseResult['tabs']>()
    const { ensure, status, inspect, stop, running, permit } = yield* lifecycle(
      api,
      saved,
      (key) => {
        tabs.delete(key)
        drivers.delete(key)
      },
    )
    /** Keep the public session through one guest generation so later reads retain the existing
     * profile grant. Resume or a guest service restart discards stale refs and session authority. */
    const nativeDriver = Effect.fn('Machine.boat.native')(function* (key: MachineKey) {
      const identity = yield* running(key)
      const current = yield* guestDriver(api, identity.id, key)
      const previous = drivers.get(key)
      if (previous !== undefined && previous.generation === current.generation)
        return previous.native
      drivers.set(key, current)
      return current.native
    })
    return Machine.of({
      /** The prepared payload opens the native launcher once per desktop session. This is
       * presentation setup only; expensive installation happened before template capture.
       *
       * The same command first settles whose machine this is (`boat/holder.ts`): the machine
       * records its one holder on its own disk, and a binding it does not name is refused
       * before anything is opened. The table cannot do this alone, because another server has
       * another table. A refused binding is given up here, so this server's table does not go
       * on saying the account holds a machine that says otherwise. */
      ensure: Effect.fn('Machine.boat.ensure')(function* (key) {
        const state = yield* ensure(key)
        const identity = yield* running(key)
        if (!holdable(identity.binding.intent))
          return yield* Effect.fail(new MachinePersistenceFailed())
        const receipt = yield* api.command(
          identity.id,
          key,
          wakeCommand({ id: identity.id, intent: identity.binding.intent }),
          30,
        )
        if (receipt.exitCode === HELD) {
          yield* saved.release(key, identity.binding.intent)
          tabs.delete(key)
          drivers.delete(key)
          return yield* Effect.fail(new MachineHeld())
        }
        if (receipt.exitCode !== 0 || receipt.timedOut)
          return yield* Effect.fail(new MachineOperationFailed({ operation: 'desktop-launcher' }))
        return state
      }),
      status,
      inspect,
      stop,
      screen: Effect.fn('Machine.boat.relay')(() =>
        Effect.fail(new MachineCapabilityUnavailable({ capability: 'relay' })),
      ),
      exec: Effect.fn('Machine.boat.exec')(
        function* (input) {
          if (
            !Number.isInteger(input.timeoutSeconds) ||
            input.timeoutSeconds < 1 ||
            input.timeoutSeconds > 600 ||
            input.command.length < 1 ||
            input.command.length > 8000
          )
            return yield* Effect.fail(new MachineInputInvalid())
          const identity = yield* running(input.key)
          const receipt = yield* api.command(
            identity.id,
            input.key,
            input.command,
            input.timeoutSeconds,
          )
          if (receipt.exitCode === null)
            return yield* Effect.fail(new MachineResponseInvalid({ operation: 'command-exit' }))
          const output = receipt.stdout + receipt.stderr
          return {
            exitCode: receipt.exitCode,
            output: output.slice(0, 32768),
            truncated:
              receipt.stdoutTruncated === true ||
              receipt.stderrTruncated === true ||
              output.length > 32768,
          }
        },
        (effect, input) => permit(input.key).withPermit(effect),
      ),
      desktop: Effect.fn('Machine.boat.desktop')(
        function* (input) {
          const identity = yield* running(input.key)
          const native = yield* nativeDriver(input.key)
          yield* desktopStep(native, input.action)
          return yield* look(native, api, { id: identity.id, key: input.key })
        },
        (effect, input) => permit(input.key).withPermit(effect),
      ),
      browse: Effect.fn('Machine.boat.browse')(
        function* (input) {
          const result = yield* browse(
            yield* nativeDriver(input.key),
            input.action,
            Option.fromUndefinedOr(tabs.get(input.key)),
          )
          tabs.set(input.key, result.tabs)
          return result
        },
        (effect, input) => permit(input.key).withPermit(effect),
      ),
    })
  }),
)

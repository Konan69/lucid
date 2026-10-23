import { type BrowseResult } from '@vivid/contracts'
import { Effect, Layer, Option, Semaphore, Stream } from 'effect'
import {
  Machine,
  MachineCapabilityUnavailable,
  MachineInputInvalid,
  MachineOutput,
  MachineResponseInvalid,
  MachineOperationFailed,
  type MachineFailure,
  type MachineKey,
  type MachineOperations,
} from './machine.ts'
import { bindings } from './boat/bindings.ts'
import type { CommandFrame, ProviderId } from './boat/protocol.ts'
import { transport, type Transport } from './boat/transport.ts'
import type { Driver } from './boat/driver.ts'
import { guestDriver } from './boat/guest.ts'
import { desktopStep, look } from './boat/desktop.ts'
import { browse, signInTarget } from './boat/browser.ts'
import { injectSignInCookies } from './signins/inject.ts'
import { lifecycle } from './boat/lifecycle.ts'
import { machineLinks } from './boat/shell.ts'
import { holding, wake } from './boat/holder.ts'
import { browserProxy, startProxy } from './egress/guest.ts'

/** Cookie input belongs to the provider's existing browser and machine permit. The accepted
 * binding's SSH operation owns the private input and ends with the injection scope. */
const makeCookieCopy = (input: {
  readonly native: (key: MachineKey) => Effect.Effect<Driver, MachineFailure>
  readonly operations: Pick<MachineOperations, 'converse' | 'run'>
  readonly permit: (key: MachineKey) => Semaphore.Semaphore
}) =>
  Effect.fn('Machine.boat.copySignIn')(
    function* (request: Parameters<MachineOperations['copySignIn']>[0]) {
      const window = yield* signInTarget(
        yield* input.native(request.key),
        browserProxy(request.egress, startProxy(input.operations, request.key)),
      )
      return yield* injectSignInCookies({
        pid: window.pid,
        windowId: window.window_id,
        cookies: request.cookies,
        converse: (command) =>
          input.operations.converse({
            key: request.key,
            command,
            directory: '.',
            timeoutSeconds: 30,
          }),
      })
    },
    (effect, request) => input.permit(request.key).withPermit(effect),
  )

/** What Boat says about a streamed command, as the machine boundary tells it. Standard error is
 * dropped: it is never part of what a caller reads. */
const told = (
  frame: CommandFrame,
): Effect.Effect<ReadonlyArray<MachineOutput>, MachineOperationFailed> => {
  if (frame.type === 'stdout')
    return Effect.succeed([MachineOutput.cases.Printed.make({ text: frame.data })])
  if (frame.type === 'exit')
    return Effect.succeed([
      MachineOutput.cases.Exited.make({
        exitCode: frame.exitCode,
        timedOut: frame.timedOut,
        memory: frame.oomKilled === true,
      }),
    ])
  // Boat could not run or follow the command; it says so in place of an exit.
  if (frame.type === 'error')
    return Effect.fail(new MachineOperationFailed({ operation: 'command-stream' }))
  return Effect.succeed([])
}

/** The same bounds as `exec`, checked before anything is sent. */
const followed = (
  api: Transport,
  id: ProviderId,
  input: { readonly command: string; readonly timeoutSeconds: number },
): Stream.Stream<MachineOutput, MachineFailure> => {
  if (
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 1 ||
    input.timeoutSeconds > 600 ||
    input.command.length < 1 ||
    input.command.length > 8000
  )
    return Stream.fail(new MachineInputInvalid())
  return api
    .follow(id, input.command, input.timeoutSeconds)
    .pipe(Stream.mapEffect(told), Stream.flattenIterable)
}

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
    const forget = (key: MachineKey) => {
      tabs.delete(key)
      drivers.delete(key)
    }
    const { settle, admit } = holding(api, saved, forget)
    // The lifecycle tells this Layer when a machine stops or resumes; what was cached about the
    // machine it was is forgotten then, and the SSH connection to it is closed.
    const connections = machineLinks(api)
    yield* Effect.addFinalizer(() => connections.close)
    const { ensure, status, inspect, stop, running, permit } = yield* lifecycle(
      api,
      saved,
      (key) =>
        Effect.suspend(() => {
          forget(key)
          return connections.forget(key)
        }),
      admit,
    )
    /** A running machine that has accepted this binding. Everything here that reaches a machine
     * starts from this, never from `running` alone: that would let a binding the machine does
     * not name use it. */
    const accepted = Effect.fn('Machine.boat.accepted')(function* (key: MachineKey) {
      return yield* admit(key, yield* running(key))
    })
    /** Keep the public session through one guest generation so later reads retain the existing
     * profile grant. Resume or a guest service restart discards stale refs and session authority. */
    const nativeDriver = Effect.fn('Machine.boat.native')(function* (key: MachineKey) {
      const identity = yield* accepted(key)
      const current = yield* guestDriver(api, identity.id, key)
      const previous = drivers.get(key)
      if (previous !== undefined && previous.generation === current.generation)
        return previous.native
      drivers.set(key, current)
      return current.native
    })
    const shell = connections.operations(accepted)
    return Machine.of({
      copySignIn: makeCookieCopy({
        native: nativeDriver,
        operations: connections.operations(accepted),
        permit,
      }),
      /** The prepared payload opens the native launcher once per desktop session. This is
       * presentation setup only; expensive installation happened before template capture.
       *
       * The same command first settles whose machine this is (`boat/holder.ts`), at every wake,
       * so a machine that names another holder opens nothing for this one. */
      ensure: Effect.fn('Machine.boat.ensure')(function* (key) {
        const state = yield* ensure(key)
        yield* settle(key, yield* running(key), wake)
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
            return yield* new MachineInputInvalid()
          const identity = yield* accepted(input.key)
          const receipt = yield* api.command(
            identity.id,
            input.key,
            input.command,
            input.timeoutSeconds,
          )
          if (receipt.exitCode === null)
            return yield* new MachineResponseInvalid({ operation: 'command-exit' })
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
      /** No permit: a followed command lasts minutes and the actions it asks for need the
       * machine meanwhile. */
      follow: (input) =>
        Stream.unwrap(
          accepted(input.key).pipe(Effect.map((identity) => followed(api, identity.id, input))),
        ),
      write: Effect.fn('Machine.boat.write')(function* (input) {
        const identity = yield* accepted(input.key)
        yield* api.write(identity.id, input.path, input.content)
      }),
      ...shell,
      desktop: Effect.fn('Machine.boat.desktop')(
        function* (input) {
          const identity = yield* accepted(input.key)
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
            // What a browser this step starts is given as its way out (`browserProxy`).
            browserProxy(input.egress, startProxy(shell, input.key)),
          )
          tabs.set(input.key, result.tabs)
          return result
        },
        (effect, input) => permit(input.key).withPermit(effect),
      ),
    })
  }),
)

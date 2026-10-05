import { type BrowseResult } from '@vivid/contracts'
import { Effect, Layer, Option, Stream } from 'effect'
import {
  Machine,
  MachineCapabilityUnavailable,
  MachineInputInvalid,
  MachineOutput,
  MachineResponseInvalid,
  MachineOperationFailed,
  MachineAuthenticationFailed,
  MachineFileRefused,
  MachineUnreachable,
  type MachineFailure,
  type MachineKey,
} from './machine.ts'
import { bindings } from './boat/bindings.ts'
import type { CommandFrame, ProviderId } from './boat/protocol.ts'
import { transport, type Transport } from './boat/transport.ts'
import type { Driver } from './boat/driver.ts'
import { guestDriver } from './boat/guest.ts'
import { desktopStep, look } from './boat/desktop.ts'
import { browse } from './boat/browser.ts'
import { lifecycle } from './boat/lifecycle.ts'
import { links } from './ssh/links.ts'
import {
  LinkFileRefused,
  LinkHostMismatch,
  LinkKeyRefused,
  LinkUnreachable,
  type Link,
  type LinkFailure,
} from './ssh/link.ts'

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

/** "host:port", as Boat names a machine that has no public address of its own. */
const endpoint = (value: string) => {
  const cut = value.lastIndexOf(':')
  return { host: value.slice(0, cut), port: Number(value.slice(cut + 1)) }
}

/**
 * What an SSH failure says at the machine boundary. A host that presents another key is some other
 * machine at an address this one had: the provider's answer did not describe what was reached,
 * which is an invalid response, never a machine to use. A lost or refused connection is an outage
 * of the path to the machine and says nothing about the machine.
 */
const linkFailure = (failure: LinkFailure | LinkFileRefused): MachineFailure => {
  if (failure instanceof LinkFileRefused) return new MachineFileRefused({ reason: failure.reason })
  if (failure instanceof LinkHostMismatch)
    return new MachineResponseInvalid({ operation: 'ssh-host-key' })
  if (failure instanceof LinkKeyRefused) return new MachineAuthenticationFailed()
  return new MachineUnreachable()
}
const isLinkFailure = (
  failure: MachineFailure | LinkFailure | LinkFileRefused,
): failure is LinkFailure | LinkFileRefused =>
  failure instanceof LinkUnreachable ||
  failure instanceof LinkHostMismatch ||
  failure instanceof LinkKeyRefused ||
  failure instanceof LinkFileRefused

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
    // The lifecycle tells this Layer when a machine stops or resumes (`invalidate` below); the
    // connection to the machine it was is closed then.
    const connections = links<MachineKey>(api.pair)
    const { ensure, status, inspect, stop, running, permit } = yield* lifecycle(
      api,
      saved,
      (key) => {
        tabs.delete(key)
        drivers.delete(key)
        return connections.drop(key)
      },
    )
    /** Lets the installation's key in and reads where the machine is now. */
    const locate = Effect.fn('Machine.boat.locate')(function* (key: MachineKey) {
      const identity = yield* running(key)
      const reply = yield* api.authorize(identity.id)
      const place =
        typeof reply.sshEndpoint === 'string' && reply.sshEndpoint !== ''
          ? endpoint(reply.sshEndpoint)
          : { host: reply.machineIp, port: 22 }
      return { ...place, user: reply.sshUser, hostKey: reply.hostKey }
    })
    /**
     * One call on the machine's connection. A call that finds the connection gone closes it, so
     * the next call dials afresh with a new address; this call is not repeated, because a command
     * may have run.
     */
    const overLink = <A>(
      key: MachineKey,
      call: (link: Link) => Effect.Effect<A, LinkFailure | LinkFileRefused>,
    ): Effect.Effect<A, MachineFailure> =>
      connections.get(key, locate(key)).pipe(
        Effect.flatMap(call),
        Effect.tapError((failure) =>
          failure instanceof LinkUnreachable ? connections.drop(key) : Effect.void,
        ),
        Effect.mapError((failure) => (isLinkFailure(failure) ? linkFailure(failure) : failure)),
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
       * presentation setup only; expensive installation happened before template capture. */
      ensure: Effect.fn('Machine.boat.ensure')(function* (key) {
        const state = yield* ensure(key)
        const identity = yield* running(key)
        const receipt = yield* api.command(
          identity.id,
          key,
          '/opt/vivid/python/bin/python3 /opt/vivid/computer/desktop.py start',
          30,
        )
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
      /** No permit: a followed command lasts minutes and the actions it asks for need the
       * machine meanwhile. */
      follow: (input) =>
        Stream.unwrap(
          running(input.key).pipe(Effect.map((identity) => followed(api, identity.id, input))),
        ),
      write: Effect.fn('Machine.boat.write')(function* (input) {
        const identity = yield* running(input.key)
        yield* api.write(identity.id, input.path, input.content)
      }),
      run: Effect.fn('Machine.boat.run')(function* (input) {
        if (
          !Number.isInteger(input.timeoutSeconds) ||
          input.timeoutSeconds < 1 ||
          input.command.length < 1
        )
          return yield* Effect.fail(new MachineInputInvalid())
        return yield* overLink(input.key, (link) =>
          link.run({
            command: input.command,
            directory: input.directory,
            timeoutSeconds: input.timeoutSeconds,
          }),
        )
      }),
      read: Effect.fn('Machine.boat.read')((input) =>
        overLink(input.key, (link) => link.read(input.path)),
      ),
      put: Effect.fn('Machine.boat.put')((input) =>
        overLink(input.key, (link) => link.put(input.path, input.content)),
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

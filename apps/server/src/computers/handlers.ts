import { Effect, Exit, Scope, Stream } from 'effect'
import {
  ComputerResponse,
  type ReportDeviceStopRequest,
  type UseWindowRequest,
  DeviceListResponse,
  DeviceResponse,
  type AnswerDeviceRequest,
  type BrowseRequest,
  type Device,
  type DeviceId,
  type EnrolDeviceRequest,
  type UseDesktopRequest,
  type RunCommandRequest,
  type ComputerShellRequest,
  type ComputerFileReadRequest,
  type ComputerFileWriteRequest,
  type WatchDeviceRequestsRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { Changes, Topic } from '../live/changes.ts'
import { live, sessionEnded } from '../live/query.ts'
import { computerWindow } from './windows.ts'
import { DeviceRegistry } from './device.ts'
import {
  ComputerStore,
  computerRunCommand,
  computerBrowse,
  computerDesktop,
  computerShell,
  computerFileRead,
  computerFileWrite,
} from './store.ts'
import { computerInventory } from './inventory.ts'
export { computerRunner } from './store.ts'

/** A plain and live read share the same Computer loader and wire envelope. */
const load = Effect.fn('Computer.load')(function* (actor: Actor) {
  const store = yield* ComputerStore
  return ComputerResponse.make({ computer: yield* store.get(actor.person.id) })
})

/**
 * One-shot and live callers share the Person-owned loader. Presence and desktop sockets belong
 * to this process: the server must stay at one replica until presence is shared and browse
 * requests can be routed to the replica holding the socket (device.ts#DeviceRegistry).
 */
const loadDevices = Effect.fn('Computer.loadDevices')(function* (actor: Pick<Actor, 'person'>) {
  return DeviceListResponse.make({ devices: yield* (yield* DeviceRegistry).list(actor.person.id) })
})

/** The calling Person's computers, wrapped for the wire. */
const one = (device: Device) => DeviceResponse.make({ device })

/**
 * Admission owns a private scope so a refused watch closes any partial link without publishing.
 * The caller's acquireRelease closes this scope before announcing Offline, including replacement,
 * revocation and session expiry. Public Scope APIs preserve registry release ordering.
 */
const admitted = Effect.fn('Computer.admitted')(function* (
  auth: Effect.Success<ReturnType<typeof requirePerson>>,
  request: WatchDeviceRequestsRequest,
) {
  const scope = yield* Scope.make()
  const requests = yield* (yield* DeviceRegistry)
    .watch({
      personId: auth.person.id,
      sessionId: auth.sessionId,
      device: request.device,
      installation: request.installation,
      ability: request.ability,
    })
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    )
  return { scope, requests }
})

/**
 * A Person's call is always about their own Computer and their own computers: none of these takes
 * a Person to act on, and Vivid's tools get the same owner from the identity they act with.
 */
export const computerHandlers = {
  /** Metadata uses the same authenticated owner as every other Computer operation. */
  GetComputerApps: Effect.fn('Rpc.GetComputerApps')(function* () {
    const auth = yield* requireActor()
    return yield* computerInventory(auth.person.id)
  }),
  EnrolDevice: Effect.fn('Rpc.EnrolDevice')(function* (request: EnrolDeviceRequest) {
    const auth = yield* requirePerson()
    const device = yield* (yield* DeviceRegistry).enrol(auth.person.id, request)
    yield* (yield* Changes).publish([Topic.person(auth.person.id)])
    return one(device)
  }),
  /** Installation and Run ownership are checked by the registry before the shared Stop path. */
  ReportDeviceStop: Effect.fn('Rpc.ReportDeviceStop')(function* (request: ReportDeviceStopRequest) {
    const auth = yield* requirePerson()
    yield* (yield* DeviceRegistry).reportStop(auth.person.id, request)
  }),
  UseWindow: Effect.fn('Rpc.UseWindow')(function* (request: UseWindowRequest) {
    yield* requireVivid()
    return yield* computerWindow(yield* requireActor(), request)
  }),
  ListDevices: Effect.fn('Rpc.ListDevices')(function* () {
    return yield* loadDevices(yield* requirePerson())
  }),
  /** Resolve session authority again on every change, as for the other live product lists. */
  WatchDevices: () => live(loadDevices),
  AllowDevice: Effect.fn('Rpc.AllowDevice')(function* ({ id }: { readonly id: DeviceId }) {
    const auth = yield* requirePerson()
    const device = yield* (yield* DeviceRegistry).allow(auth.person.id, id)
    yield* (yield* Changes).publish([Topic.person(auth.person.id)])
    return one(device)
  }),
  RevokeDevice: Effect.fn('Rpc.RevokeDevice')(function* ({ id }: { readonly id: DeviceId }) {
    const auth = yield* requirePerson()
    const device = yield* (yield* DeviceRegistry).revoke(auth.person.id, id)
    yield* (yield* Changes).publish([Topic.person(auth.person.id)])
    return one(device)
  }),
  /**
   * Holding this open is what makes the computer `Connected`, so it ends as soon as the right to
   * hold it does: when access is revoked (the registry ends the link), and when the session that
   * opened it is signed out or runs out (`sessionEnded`), even if the socket stays up.
   */
  WatchDeviceRequests: (request: WatchDeviceRequestsRequest) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const auth = yield* requirePerson()
        const changes = yield* Changes
        const link = yield* Effect.acquireRelease(admitted(auth, request), ({ scope }, exit) =>
          Scope.close(scope, exit).pipe(
            Effect.andThen(changes.publish([Topic.person(auth.person.id)])),
          ),
        )
        yield* changes.publish([Topic.person(auth.person.id)])
        return link.requests.pipe(
          Stream.interruptWhen(sessionEnded(auth.person.id, auth.sessionId)),
        )
      }),
    ),
  AnswerDeviceRequest: Effect.fn('Rpc.AnswerDeviceRequest')(function* (input: AnswerDeviceRequest) {
    const auth = yield* requirePerson()
    return yield* (yield* DeviceRegistry).answer(auth.person.id, auth.sessionId, input)
  }),
  GetComputer: Effect.fn('Rpc.GetComputer')(function* () {
    const auth = yield* requirePerson()
    const store = yield* ComputerStore
    return ComputerResponse.make({ computer: yield* store.get(auth.person.id) })
  }),
  /** The subscription owns watching presence; ending it starts a fresh idle deadline. */
  WatchComputer: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const auth = yield* requirePerson()
        yield* (yield* ComputerStore).watching(auth.person.id)
        return live(load)
      }),
    ),
  StartComputer: Effect.fn('Rpc.StartComputer')(function* () {
    const auth = yield* requirePerson()
    const store = yield* ComputerStore
    return ComputerResponse.make({ computer: yield* store.start(auth.person.id) })
  }),
  StopComputer: Effect.fn('Rpc.StopComputer')(function* () {
    const auth = yield* requirePerson()
    const store = yield* ComputerStore
    return ComputerResponse.make({ computer: yield* store.stop(auth.person.id) })
  }),
  HoldComputer: Effect.fn('Rpc.HoldComputer')(function* ({ held }: { readonly held: boolean }) {
    const auth = yield* requirePerson()
    const store = yield* ComputerStore
    return ComputerResponse.make({ computer: yield* store.hold(auth.person.id, held) })
  }),
  RunCommand: Effect.fn('Rpc.RunCommand')(function* (request: RunCommandRequest) {
    yield* requireVivid()
    return yield* computerRunCommand(yield* requireActor(), request)
  }),
  ComputerShell: Effect.fn('Rpc.ComputerShell')(function* (request: ComputerShellRequest) {
    yield* requireVivid()
    return yield* computerShell(yield* requireActor(), request)
  }),
  ComputerFileRead: Effect.fn('Rpc.ComputerFileRead')(function* (
    request: ComputerFileReadRequest,
  ) {
    yield* requireVivid()
    return yield* computerFileRead(yield* requireActor(), request)
  }),
  ComputerFileWrite: Effect.fn('Rpc.ComputerFileWrite')(function* (
    request: ComputerFileWriteRequest,
  ) {
    yield* requireVivid()
    return yield* computerFileWrite(yield* requireActor(), request)
  }),
  Browse: Effect.fn('Rpc.Browse')(function* (request: BrowseRequest) {
    yield* requireVivid()
    return yield* computerBrowse(yield* requireActor(), request)
  }),
  UseDesktop: Effect.fn('Rpc.UseDesktop')(function* (request: UseDesktopRequest) {
    yield* requireVivid()
    return yield* computerDesktop(yield* requireActor(), request)
  }),
}

import { Effect, Stream } from 'effect'
import {
  ComputerResponse,
  DeviceListResponse,
  DeviceResponse,
  type AnswerDeviceRequest,
  type BrowseRequest,
  type Device,
  type DeviceId,
  type EnrolDeviceRequest,
  type UseDesktopRequest,
  type RunCommandRequest,
  type WatchDeviceRequestsRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { live, sessionEnded } from '../live/query.ts'
import { DeviceRegistry } from './device.ts'
import { ComputerStore, computerRunCommand, computerBrowse, computerDesktop } from './store.ts'
export { computerRunner } from './store.ts'

/** A plain and live read share the same Computer loader and wire envelope. */
const load = Effect.fn('Computer.load')(function* (actor: Actor) {
  const store = yield* ComputerStore
  return ComputerResponse.make({ computer: yield* store.get(actor.person.id) })
})

/** The calling Person's computers, wrapped for the wire. */
const one = (device: Device) => DeviceResponse.make({ device })

/**
 * A Person's call is always about their own Computer and their own computers: none of these takes
 * a Person to act on, and Vivid's tools get the same owner from the identity they act with.
 */
export const computerHandlers = {
  EnrolDevice: Effect.fn('Rpc.EnrolDevice')(function* (request: EnrolDeviceRequest) {
    const auth = yield* requirePerson()
    const device = yield* (yield* DeviceRegistry).enrol(auth.person.id, request)
    yield* changed(auth)
    return one(device)
  }),
  ListDevices: Effect.fn('Rpc.ListDevices')(function* () {
    const auth = yield* requirePerson()
    return DeviceListResponse.make({
      devices: yield* (yield* DeviceRegistry).list(auth.person.id),
    })
  }),
  AllowDevice: Effect.fn('Rpc.AllowDevice')(function* ({ id }: { readonly id: DeviceId }) {
    const auth = yield* requirePerson()
    const device = yield* (yield* DeviceRegistry).allow(auth.person.id, id)
    yield* changed(auth)
    return one(device)
  }),
  RevokeDevice: Effect.fn('Rpc.RevokeDevice')(function* ({ id }: { readonly id: DeviceId }) {
    const auth = yield* requirePerson()
    const device = yield* (yield* DeviceRegistry).revoke(auth.person.id, id)
    yield* changed(auth)
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
        const requests = yield* (yield* DeviceRegistry).watch({
          personId: auth.person.id,
          sessionId: auth.sessionId,
          device: request.device,
          installation: request.installation,
        })
        return requests.pipe(Stream.interruptWhen(sessionEnded(auth.person.id, auth.sessionId)))
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
  Browse: Effect.fn('Rpc.Browse')(function* (request: BrowseRequest) {
    yield* requireVivid()
    return yield* computerBrowse(yield* requireActor(), request)
  }),
  UseDesktop: Effect.fn('Rpc.UseDesktop')(function* (request: UseDesktopRequest) {
    yield* requireVivid()
    return yield* computerDesktop(yield* requireActor(), request)
  }),
}

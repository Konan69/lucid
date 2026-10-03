import { Effect, Stream } from 'effect'
import {
  ComputerResponse,
  type AnswerDeviceRequest,
  type BrowseRequest,
  type UseDesktopRequest,
  type RunCommandRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { Device } from './device.ts'
import { sessionWorkspace } from '../auth/session.ts'
import { live, watch } from '../live/query.ts'
import { Topic } from '../live/changes.ts'
import { ComputerStore, computerRunCommand, computerBrowse, computerDesktop } from './store.ts'
export { computerRunner } from './store.ts'

/** A plain and live read share the same Computer loader and wire envelope. */
const load = Effect.fn('Computer.load')(function* (actor: Actor) {
  const store = yield* ComputerStore
  return ComputerResponse.make({ computer: yield* store.get(actor.person.id) })
})

/** Person calls never accept a target identity; Vivid tools derive the same owner from the acting identity. */
export const computerHandlers = {
  /** Session revocation ends presence even if the socket remains open. Workspace changes retain the device. */
  WatchDeviceRequests: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const auth = yield* requirePerson()
        const device = yield* Device
        const valid = watch(
          [Topic.person(auth.person.id)],
          sessionWorkspace(auth.person.id, auth.sessionId),
        ).pipe(Stream.runDrain)
        return (yield* device.watch(auth.person.id, auth.sessionId)).pipe(
          Stream.interruptWhen(valid),
        )
      }),
    ),
  AnswerDeviceRequest: Effect.fn('Rpc.AnswerDeviceRequest')(function* (input: AnswerDeviceRequest) {
    const auth = yield* requirePerson()
    return yield* (yield* Device).answer(auth.person.id, auth.sessionId, input)
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

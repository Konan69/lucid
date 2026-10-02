import { Effect } from 'effect'
import {
  ComputerResponse,
  type BrowseRequest,
  type UseDesktopRequest,
  type RunCommandRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { ComputerStore, computerRunCommand, computerBrowse, computerDesktop } from './store.ts'
export { computerRunner } from './store.ts'

/** A plain and live read share the same Computer loader and wire envelope. */
const load = Effect.fn('Computer.load')(function* (actor: Actor) {
  const store = yield* ComputerStore
  return ComputerResponse.make({ computer: yield* store.get(actor.person.id) })
})

/** Person calls never accept a target identity; Vivid tools derive the same owner from the acting identity. */
export const computerHandlers = {
  GetComputer: Effect.fn('Rpc.GetComputer')(function* () {
    const auth = yield* requirePerson()
    const store = yield* ComputerStore
    return ComputerResponse.make({ computer: yield* store.get(auth.person.id) })
  }),
  WatchComputer: () => live(load),
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

import * as Effect from 'effect/Effect'
import {
  StopAllWorkResponse,
  StopWorkResponse,
  WorkListResponse,
  type WorkRef,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { listWork } from './list.ts'
import { stopAllWork, stopWork } from './stop.ts'

/** List and Watch load exactly the same projection. */
const work = Effect.fn('Work.load')(function* (actor: Actor) {
  return WorkListResponse.make({ work: yield* listWork(actor) })
})

/**
 * Background work for the Person or for Vivid acting for them. The live query hears Run changes:
 * a Run's start, end and Stop announce its Thread owner's `feed` part (`feed/changes.ts`), and a
 * turn's delivery the audience's `activity` part. Watches and Integrations announce their owner
 * whole, which every query hears.
 */
export const workHandlers = {
  ListWork: Effect.fn('Rpc.ListWork')(function* () {
    return yield* work(yield* requireActor())
  }),
  WatchWork: () => live('WatchWork', ['activity', 'feed'], work),
  StopWork: Effect.fn('Rpc.StopWork')(function* ({ work: ref }: { readonly work: WorkRef }) {
    return StopWorkResponse.make({ result: yield* stopWork(yield* requireActor(), ref) })
  }),
  StopAllWork: Effect.fn('Rpc.StopAllWork')(function* () {
    return StopAllWorkResponse.make({ stopped: yield* stopAllWork(yield* requireActor()) })
  }),
}

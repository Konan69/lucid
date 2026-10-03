import { type ReadPageRequest } from '@vivid/contracts'
import { Effect, Semaphore } from 'effect'
import { budgets } from './budgets.ts'
import { PageReader } from './page.ts'

/** Shared page slots queue independent Promise.all reads; program supervision bounds their wait. */
const capacity = Semaphore.makeUnsafe(budgets.pages)
export const readPage = Effect.fn('Code.admitPage')(function* (request: ReadPageRequest) {
  const reader = yield* PageReader
  return yield* capacity.withPermits(1)(reader.read(request))
})

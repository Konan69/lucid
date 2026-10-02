import { ReadPageOutcome, type ReadPageRequest } from '@vivid/contracts'
import { Effect, Option, Semaphore } from 'effect'
import { budgets } from './budgets.ts'
import { PageReader } from './page.ts'

/** All RPC and program reads share one admission budget; queued stale reads are refused immediately. */
const capacity = Semaphore.makeUnsafe(budgets.pages)
export const readPage = Effect.fn('Code.admitPage')(function* (request: ReadPageRequest) {
  const reader = yield* PageReader
  const admitted = yield* capacity.withPermitsIfAvailable(1)(reader.read(request))
  return Option.getOrElse(admitted, () =>
    ReadPageOutcome.cases.Refused.make({ reason: 'could not be reached' }),
  )
})

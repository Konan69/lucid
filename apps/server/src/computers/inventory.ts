import { ComputerInventory, ComputerState, type PersonId } from '@vivid/contracts'
import { Effect, Result, Schema } from 'effect'
import { ComputerStore } from './store.ts'

/** Optional inventory enrichment may be omitted while the Computer keeps its own work alive.
 * Source: unmeasured. After thirty seconds the caller uses the explicit Unavailable context;
 * this is not the action the Person requested and is never authority to act. */
const INVENTORY_CONTEXT_SECONDS = 30

const decode = Schema.decodeUnknownResult(Schema.fromJsonString(ComputerInventory))

/** Observe through the ordinary Computer service; this never creates a Computer for a chat.
 * The prepared machine's catalogue probes real packages, executables and launcher files, so removed apps
 * disappear rather than retaining a static promise. Provider loss, takeover and legacy templates
 * deliberately supply no names; inventory is optional response context, not authority to act. */
export const computerInventory = Effect.fn('Computer.inventory')(function* (person: PersonId) {
  const store = yield* ComputerStore
  const computer = yield* store.get(person)
  if (!ComputerState.guards.Running(computer.state))
    return ComputerInventory.cases.Unavailable.make({})
  const receipt = yield* store
    .probe(person, {
      command: '/opt/vivid/python/bin/python3 /opt/vivid/computer/catalogue.py inventory',
      timeoutSeconds: INVENTORY_CONTEXT_SECONDS,
    })
    .pipe(Effect.result)
  if (Result.isFailure(receipt) || receipt.success.exitCode !== 0 || receipt.success.truncated)
    return ComputerInventory.cases.Unavailable.make({})
  return Result.getOrElse(decode(receipt.success.output), () =>
    ComputerInventory.cases.Unavailable.make({}),
  )
})

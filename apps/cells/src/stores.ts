import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import { StoreUnavailable, Stores } from '@vivid/agent-runtime/cell'
import type { PersonId } from '@vivid/contracts'
import { Effect, Layer } from 'effect'
import type { Meter } from './meter.ts'

/**
 * The cell's `Stores`: one Person, one store, which is Pi's own Durable Object SQLite adapter on
 * this cell's `ctx.storage`. Each open makes a fresh adapter, as Pi expects a store per Harness;
 * the database underneath is the cell's and nothing is closed but Pi's queue.
 *
 * `working` names this Person always. The runtime's `resume` (`persons.ts`) opens the Harness,
 * asks Pi whether anything is unfinished and closes it again when nothing is, so it is the
 * runtime, not this layer, that decides; that is how a reply a dead node was writing continues on
 * the node that takes the cell over. `lost` never fails: celld fences a stale owner by epoch
 * (`guarantees.md`), so there is no control connection to lose.
 */
export const storesLayer = (owner: PersonId, metered: Meter) =>
  Layer.succeed(
    Stores,
    Stores.of({
      open: (personId) =>
        personId === owner
          ? Effect.tryPromise({
              try: () => openDurableObjectSqliteStorage(metered.storage),
              catch: (cause) => new StoreUnavailable({ cause }),
            })
          : Effect.fail(new StoreUnavailable({ cause: 'This cell holds another Person' })),
      working: Effect.succeed([owner]),
      lost: Effect.never,
    }),
  )

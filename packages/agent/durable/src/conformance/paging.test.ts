import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Effect } from 'effect'
import { historyCases } from '../fixtures/paging.ts'
import { FixtureFailed } from '../fixtures/harness.ts'

/** The published SQLite adapter owns paging; every case has a fresh in-memory database. */
historyCases('SQLite', () =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(':memory:'),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (storage) => Effect.promise(() => storage.close(BACKGROUND_CONTEXT)),
  ),
)

import * as Layer from 'effect/Layer'
import * as PersistedQueue from 'effect/unstable/persistence/PersistedQueue'

export const WORK_TABLE = 'vivid_work'

/**
 * The native store owns its SQL schema and claims. rc.116 PersistedQueue.ts:1297,1347-1353
 * captures the supplied SqlClient, so composition must expose the same authority as Drizzle.
 * The factory and store remain available for ingestion and SDK cleanup in the owning scope.
 */
export const workLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({ tableName: WORK_TABLE, pollInterval: '250 millis' }),
  ),
)

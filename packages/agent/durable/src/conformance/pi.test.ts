import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { describe, expect, it } from 'vitest'

/**
 * Pi: packages/durable/test/memory-storage.test.ts, registerStorageConformance.
 * Each generated test keeps its upstream name from src/testing/storage-conformance.ts.
 * Use the real SQLite adapter used by recovery.test.ts, with a fresh database per case.
 * No environment conformance: this package does not supply an ExecutionEnv.
 */
registerStorageConformance({ describe, expect, it }, 'Pi SQLite storage', async (use) => {
  const storage = await openNodeSqliteStorage(':memory:')
  try {
    await use(storage)
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
  }
})

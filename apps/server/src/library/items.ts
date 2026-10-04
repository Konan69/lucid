import type * as Effect from 'effect/Effect'
import type { libraryIngestion } from './ingestion.ts'
import type { LibraryStoreService, DecodeItem, LibraryDatabase } from './store.ts'
import { itemReads } from './reads.ts'
import { itemWrites } from './writes.ts'

/** Combines the read and write capabilities that make up the Library item store. */
export const itemOperations = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  getFolder: LibraryStoreService['getFolder'],
  queue: Effect.Success<ReturnType<typeof libraryIngestion>>,
): Pick<
  LibraryStoreService,
  | 'listItems'
  | 'getItem'
  | 'getStoredItem'
  | 'getStoredItemByName'
  | 'getItemByDigest'
  | 'createItem'
  | 'patchItem'
  | 'removeItem'
> => {
  const reads = itemReads(database, decodeItem)
  const writes = itemWrites(database, decodeItem, { reads, getFolder, queue })
  return { ...reads, ...writes }
}

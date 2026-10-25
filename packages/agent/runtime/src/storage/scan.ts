import { StorageRequestError } from '@earendil-works/pi-durable'
import type { ConversationQuery, ScanOrder, Storage } from '@earendil-works/pi-durable'
import { Option, Result, Schema } from 'effect'

const Order = Schema.Literals(['ascending', 'descending'])
const isOrder = Schema.is(Order)
const decodeCursor = Schema.decodeUnknownResult(
  Schema.Struct({ after: Schema.Int, order: Schema.optionalKey(Order) }),
)

/** Where a scan starts and which way it runs (Pi `src/storage/scan.ts`). */
type ScanStart = { readonly order: ScanOrder; readonly after: Option.Option<number> }

/**
 * Pi `src/storage/scan.ts`: a cursor owns its direction, and a cursor without one continues the
 * table's default. The cursor is decoded before any SQL, and an explicit order that contradicts
 * the cursor is refused rather than silently skipping or repeating rows.
 */
export function scanStart(
  requested: ConversationQuery['order'],
  cursor: Parameters<Storage['scanTasks']>[2],
  fallback: ScanOrder,
): ScanStart {
  if (requested !== undefined && !isOrder(requested))
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`)
  if (cursor === undefined)
    return { order: requested === undefined ? fallback : requested, after: Option.none() }
  const decoded = decodeCursor(cursor)
  if (Result.isFailure(decoded)) throw new StorageRequestError('Invalid storage cursor')
  const order = decoded.success.order === undefined ? fallback : decoded.success.order
  if (requested !== undefined && requested !== order)
    throw new StorageRequestError(
      `The cursor continues a ${order} scan; the query asks for ${requested}`,
    )
  return { order, after: Option.some(decoded.success.after) }
}

/**
 * Pi `SqliteStorage`: only these closed fragments steer comparison and sorting;
 * the cursor id is an ordinary bound parameter.
 */
export const scanSql = (start: ScanStart) =>
  start.order === 'ascending'
    ? { clause: 'id > ?', param: Option.getOrElse(start.after, () => -1), direction: 'ASC' }
    : {
        clause: 'id < ?',
        param: Option.getOrElse(start.after, () => Number.MAX_SAFE_INTEGER),
        direction: 'DESC',
      }

import type { ConversationQuery, ScanOrder, Storage } from '@earendil-works/pi-durable'
import { Option, Result, Schema } from 'effect'

const Order = Schema.Literals(['ascending', 'descending'])
const isOrder = Schema.is(Order)
const decodeCursor = Schema.decodeUnknownResult(
  Schema.Struct({ after: Schema.Int, order: Schema.optionalKey(Order) }),
)

/** Pi 1.1.0 src/storage/scan.ts:4–8: cursor position and resolved table direction. */
type ScanStart = { readonly order: ScanOrder; readonly after: Option.Option<number> }

/** Pi 1.1.0 src/storage/scan.ts:11–35. A cursor owns its direction; legacy cursors
 * continue the table's default. Decode numeric/order bounds before SQL and reject
 * a conflicting explicit order rather than silently skipping or repeating rows. */
export function scanStart(
  requested: ConversationQuery['order'],
  cursor: Parameters<Storage['scanTasks']>[2],
  fallback: ScanOrder,
): ScanStart {
  if (requested !== undefined && !isOrder(requested))
    throw new TypeError(`Invalid scan order: ${String(requested)}`)
  if (cursor === undefined) return { order: requested ?? fallback, after: Option.none() }
  const decoded = decodeCursor(cursor)
  if (Result.isFailure(decoded)) throw new TypeError('Invalid storage cursor')
  const order = decoded.success.order ?? fallback
  if (requested !== undefined && requested !== order)
    throw new TypeError(`The cursor continues a ${order} scan; the query asks for ${requested}`)
  return { order, after: Option.some(decoded.success.after) }
}

/** Pi 1.1.0 src/storage/sqlite/storage.ts:85–89. Only these closed SQL fragments
 * control comparison and sorting; cursor ids remain ordinary bound parameters. */
export const scanSql = (start: ScanStart) =>
  start.order === 'ascending'
    ? { clause: 'id > ?', param: Option.getOrElse(start.after, () => -1), direction: 'ASC' }
    : {
        clause: 'id < ?',
        param: Option.getOrElse(start.after, () => Number.MAX_SAFE_INTEGER),
        direction: 'DESC',
      }

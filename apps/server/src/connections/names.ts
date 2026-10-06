import { Array as Arr, Option, Order } from 'effect'
import type { ConnectionRecord } from './records.ts'

/**
 * What tells one account from a Person's others on the same service, when anything does: what the
 * Person called it, else who the service says signed in. The Person's word comes first because it
 * is theirs: an account they named "Work" is "Work" to them whatever address is behind it.
 */
export const distinction = (row: Pick<ConnectionRecord, 'name' | 'identity'>) =>
  Option.orElse(Option.fromNullOr(row.name), () => Option.fromNullOr(row.identity))

/**
 * An account's name before any two are compared: "Gmail (Work)", "Gmail (ada@example.com)", or
 * "Gmail" alone. The service always leads, so the name reads the same whether a Person has one
 * account on it or five, and Vivid can say which service it is about to act through.
 */
const baseName = (row: Pick<ConnectionRecord, 'serviceName' | 'name' | 'identity'>) =>
  Option.match(distinction(row), {
    onNone: () => row.serviceName.trim(),
    onSome: (own) => `${row.serviceName.trim()} (${own})`,
  })

/**
 * Names every account an Actor can use, once, for every reader: the list a Person sees, discovery,
 * resolution and a Routine's trigger all call this, so one account never has two names.
 *
 * It names all accessible Connections before any status or query filter, in creation order, so a
 * name does not move when another account is filtered out of a result. Two accounts that would
 * read the same (two unnamed accounts on a service that does not say who signed in, or one
 * address connected twice) are told apart by a number on the later one: "DeepWiki (2)". Literal
 * names are reserved first, so an account really called "Gmail (2)" cannot collide with a number.
 */
export function namedAccounts(records: readonly ConnectionRecord[]) {
  const ordered = Arr.sort(
    records,
    Order.combine(
      Order.mapInput(Order.Number, (row: ConnectionRecord) => row.createdAt),
      Order.mapInput(Order.String, (row: ConnectionRecord) => row.id),
    ),
  )
  const reserved = new Set(ordered.map((row) => baseName(row).toLowerCase()))
  const used = new Set<string>()
  return ordered.map((row) => {
    const base = baseName(row)
    let account = base
    let occurrence = 2
    if (used.has(account.toLowerCase())) {
      do {
        account = `${base} (${occurrence++})`
      } while (used.has(account.toLowerCase()) || reserved.has(account.toLowerCase()))
    }
    used.add(account.toLowerCase())
    return { row, account }
  })
}

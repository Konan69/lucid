import { Array as Arr, Option, Order } from 'effect'
import type { ConnectionRecord } from './records.ts'

/**
 * What tells one account from a Person's others on the same service, when anything does: what the
 * Person called it, else who the service says signed in. The Person's word comes first because it
 * is theirs: an account they named "Work" is "Work" to them whatever address is behind it.
 */
const distinction = (row: Pick<ConnectionRecord, 'name' | 'identity'>) =>
  Option.orElse(Option.fromNullOr(row.name), () => Option.fromNullOr(row.identity))

/**
 * An account's name before any two are compared: "Gmail (Work)", "Gmail (ada@example.com)", or
 * "Gmail" alone. The service always leads, so the name reads the same whether a Person has one
 * account on it or five, and Vivid can say which service it is about to act through.
 *
 * An account with nothing to tell it apart is called by its place among the accounts on its
 * service, in the order they were added: the first is "Gmail", the second "Gmail (2)". The place
 * is counted over every account on the service, named or not, so it belongs to the account. It
 * was counted over the accounts that shared a name, and then naming the first account handed its
 * bare name to the second: Vivid, still holding "Gmail" for the first, would have acted through
 * the second.
 *
 * "On its service" means under the same service name too. A server added by its address is one
 * service that a Person and their Company may each have added under a name of their own, and
 * those two are not each other's second account.
 */
const baseName = (
  row: Pick<ConnectionRecord, 'serviceName' | 'name' | 'identity'>,
  place: number,
) =>
  Option.match(distinction(row), {
    onSome: (own) => `${row.serviceName.trim()} (${own})`,
    onNone: () => (place === 1 ? row.serviceName.trim() : `${row.serviceName.trim()} (${place})`),
  })

/**
 * Names every account an Actor can use, once, for every reader: the list a Person sees, discovery,
 * resolution both call this, so one account never has two names.
 *
 * It names all accessible Connections before any status or query filter, in creation order, so a
 * name does not move when another account is filtered out of a result. Two names that still read
 * the same (one address connected twice, or a Company's account and a Person's own given the same
 * name) are told apart by a number on the later one: "Gmail (ada@example.com) (2)". Literal names
 * are reserved first, so an account really called "Gmail (2)" cannot collide with a number.
 */
export function namedAccounts(records: readonly ConnectionRecord[]) {
  const ordered = Arr.sort(
    records,
    Order.combine(
      Order.mapInput(Order.Number, (row: ConnectionRecord) => row.createdAt),
      Order.mapInput(Order.String, (row: ConnectionRecord) => row.id),
    ),
  )
  const places = new Map<string, number>()
  const based = ordered.map((row) => {
    const shelf = `${row.service}\n${row.serviceName.trim().toLowerCase()}`
    const place = Option.getOrElse(Option.fromUndefinedOr(places.get(shelf)), () => 0) + 1
    places.set(shelf, place)
    return { row, base: baseName(row, place) }
  })
  const reserved = new Set(based.map(({ base }) => base.toLowerCase()))
  const used = new Set<string>()
  return based.map(({ row, base }) => {
    let account = base
    let suffix = 2
    if (used.has(account.toLowerCase())) {
      do {
        account = `${base} (${suffix++})`
      } while (used.has(account.toLowerCase()) || reserved.has(account.toLowerCase()))
    }
    used.add(account.toLowerCase())
    return { row, account }
  })
}

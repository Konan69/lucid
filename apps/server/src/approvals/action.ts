import * as NodeCrypto from 'node:crypto'
import {
  ActionTarget,
  ApprovalBinding,
  BrowseTarget,
  type PersonId,
  type ThreadId,
  type ProposedAction,
} from '@vivid/contracts'
import * as Array from 'effect/Array'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'

const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))
const entryOrder = Order.mapInput(Order.String, (entry: readonly [string, Schema.Json]) => entry[0])

/** Recursive key ordering preserves array order and binds the entire encoded invocation. */
export const canonical = (value: Schema.Json): string => {
  if (isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value))
    return `{${Array.sort(Object.entries(value), entryOrder)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/**
 * Person and Thread are part of the capability: identical tool input elsewhere needs its own
 * decision. The binding is part of it too, so the same words asked against a newer sign-in or a
 * newer document version are a different Approval, never a reuse of the older one.
 */
export const actionDigest = (proposal: {
  readonly action: typeof ProposedAction.Encoded
  readonly binding: typeof ApprovalBinding.Encoded
  readonly threadId: ThreadId
  readonly personId: PersonId
}) =>
  NodeCrypto.createHash('sha256')
    .update(canonical({ ...proposal }))
    .digest('hex')

/** An action on a Computer: it uses no Integration and carries no document, so nothing binds it. */
export const unbound = ApprovalBinding.make({ connectionGeneration: null, preconditions: [] })

/** SHA-256 of a text an action carries, so a binding can name it without repeating it. */
export const contentDigest = (text: string) =>
  NodeCrypto.createHash('sha256').update(text).digest('hex')

/** Audit metadata names the capability, never the summary or private target input. */
export const auditAction = (action: ProposedAction) =>
  ActionTarget.match(action.target, {
    Connection: ({ account, tool }) => ({ service: account, tool }),
    Browser: ({ target }) => ({
      service: BrowseTarget.guards.Person(target) ? 'Person browser' : 'Computer',
      tool: 'browser',
    }),
    Desktop: () => ({ service: 'Computer', tool: 'desktop' }),
  })

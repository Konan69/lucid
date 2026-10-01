import * as NodeCrypto from 'node:crypto'
import { ActionTarget, type PersonId, type ThreadId, type ProposedAction } from '@vivid/contracts'
import * as Array from 'effect/Array'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'

const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))
const entryOrder = Order.mapInput(Order.String, (entry: readonly [string, Schema.Json]) => entry[0])

/** Recursive key ordering preserves array order and binds the entire encoded invocation. */
const canonical = (value: Schema.Json): string => {
  if (isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value))
    return `{${Array.sort(Object.entries(value), entryOrder)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Person and Thread are part of the capability: identical tool input elsewhere needs its own decision. */
export const actionDigest = (
  action: typeof ProposedAction.Encoded,
  threadId: ThreadId,
  personId: PersonId,
) => NodeCrypto.createHash('sha256').update(canonical({ action, threadId, personId })).digest('hex')

/** Audit metadata names the capability, never the summary or private target input. */
export const auditAction = (action: ProposedAction) =>
  ActionTarget.match(action.target, {
    Connection: ({ account, tool }) => ({ service: account, tool }),
    Command: () => ({ service: 'Computer', tool: 'command' }),
    Browser: () => ({ service: 'Computer', tool: 'browser' }),
  })

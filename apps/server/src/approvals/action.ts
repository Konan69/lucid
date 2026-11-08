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
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'

const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))
const isText = Schema.is(Schema.String)
const isTexts = Schema.is(Schema.Array(Schema.String))
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

/** Whether one field of a draft may read `edited`: as it was asked, or words for words. */
const editable = (asked: Schema.Json, edited: Schema.Json) =>
  canonical(asked) === canonical(edited) ||
  (isText(asked) && isText(edited)) ||
  (isTexts(asked) && isTexts(edited))

/**
 * The action as the Person edited its draft before sending it (`AllowEdited`), or none when the
 * edit is more than a draft's words. Only an Integration action has fields to edit. The edited
 * input must hold exactly the fields Vivid wrote, and a field may change only from text to text or
 * from a list of texts to a list of texts (the recipients); a number, a flag or anything nested
 * stays as it was asked. The summary and the reason stay Vivid's: they say what was asked.
 */
export const editedAction = (
  action: ProposedAction,
  input: Schema.JsonObject,
): Option.Option<ProposedAction> => {
  const target = action.target
  if (!ActionTarget.guards.Connection(target) || !isObject(target.input)) return Option.none()
  const asked = Object.entries(target.input)
  const same =
    asked.length === Object.keys(input).length &&
    asked.every(([key, value]) => {
      const edited = input[key]
      return edited !== undefined && editable(value, edited)
    })
  if (!same) return Option.none()
  return Option.some({
    summary: action.summary,
    rationale: action.rationale,
    effect: action.effect,
    target: ActionTarget.cases.Connection.make({
      connectionId: target.connectionId,
      account: target.account,
      tool: target.tool,
      input,
    }),
  })
}

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

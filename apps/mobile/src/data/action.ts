import { Data, Predicate, type Schema } from 'effect'

/**
 * Reading the action an Approval asks about, so its card can show all of it. Pure functions over
 * the Approval's own record; the card only draws what these return.
 *
 * An Approval is consent to one exact action, so nothing here shortens, joins or tidies a value in
 * a way that could make two different actions read the same. The rules are the web card's
 * (`apps/web/src/screen/thread/Cards.tsx`), so an Approval reads the same on a phone as in a
 * browser. A step on Vivid's Computer is worded once for every surface (`browserStep` and
 * `desktopStep` in `@vivid/state`), so it is not worded here.
 */

/** A field's name as a person reads it: `reply_to` and `replyTo` are both "Reply to". */
export const fieldName = (key: string): string => {
  const words = key
    .replaceAll('_', ' ')
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .trim()
    .toLocaleLowerCase()
  return words.slice(0, 1).toLocaleUpperCase() + words.slice(1)
}

/** A JSON object, as opposed to a list or a single value. The guard keeps its values typed. */
const isRecord = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/**
 * The fields of an action's input, in the order they were written. Each keeps its own key, which
 * the card shows beside the friendly name: two keys can read the same once tidied (`reply_to`,
 * `replyTo`), and an Approval must not blur which is which. An input that is not a set of fields
 * is one field, shown whole.
 */
export const fieldsOf = (input: Schema.Json): ReadonlyArray<readonly [string, Schema.Json]> =>
  isRecord(input) ? Object.entries(input) : [['details', input] as const]

/**
 * How one value of an action is shown, without losing what kind of value it is.
 *
 * - `Text`: words, shown as words.
 * - `List`: one item to a line, each numbered, so "a, b" as one item is not two.
 * - `Literal`: anything that is not words, written as itself and set apart from them, so the word
 *   "false" and the value false cannot be mistaken for each other: a number, true, false, nothing,
 *   and anything nested, shown whole. Empty text and an empty list are written this way too
 *   (`""`, `[]`); drawn as words or as a list they would both be a blank line, and "send no
 *   recipients" must not look like "send an empty recipient".
 */
export type Shown = Data.TaggedEnum<{
  Text: { readonly text: string }
  List: { readonly items: ReadonlyArray<Schema.Json> }
  Literal: { readonly text: string }
}>
export const Shown = Data.taggedEnum<Shown>()

export const shownAs = (value: Schema.Json): Shown => {
  if (Predicate.isString(value)) {
    return value.length === 0 ? Shown.Literal({ text: '""' }) : Shown.Text({ text: value })
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? Shown.Literal({ text: '[]' }) : Shown.List({ items: value })
  }
  return Shown.Literal({ text: isRecord(value) ? JSON.stringify(value, null, 2) : String(value) })
}

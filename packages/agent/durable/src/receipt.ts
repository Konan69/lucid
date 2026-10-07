import type { UserInput } from '@earendil-works/pi-durable'
import { Predicate, Schema } from 'effect'
import { StoredImage } from './input.ts'

/** Compare the ordered native content, including filename metadata, without serializing a photo
 * into additional giant strings. A plain text submission and its equivalent single text block
 * represent the same input. Pi copies these values unchanged (submissions.js:142/168). */
const equivalent = Schema.toEquivalence(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal('text'),
        text: Schema.String,
        textSignature: Schema.optionalKey(Schema.String),
      }),
      StoredImage,
    ]),
  ),
)

/** Native and bridge admission may use either of Pi's text representations; content order matters. */
export function sameInput(left: UserInput, right: UserInput): boolean {
  const a: Exclude<UserInput, string> = Predicate.isString(left)
    ? [{ type: 'text', text: left }]
    : left
  const b: Exclude<UserInput, string> = Predicate.isString(right)
    ? [{ type: 'text', text: right }]
    : right
  return equivalent(a, b)
}

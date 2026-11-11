import { Result, Schema } from 'effect'
import vocabulary from './agents/system.json' with { type: 'json' }

/**
 * The system words Vivid must translate before a Person hears them (`agents/system.json`), with
 * what to say instead. One list feeds both checks: `scripts/plain.mjs` fails the gate on any
 * Person sentence the code writes with one of these words, and the server counts every settled
 * reply that still uses one (`apps/server/src/threads/delivery.ts`), so the check on code and the
 * count on live replies never disagree about the vocabulary.
 */
const SystemWords = Schema.Struct({
  about: Schema.String,
  words: Schema.Array(
    Schema.Struct({ id: Schema.String, pattern: Schema.String, instead: Schema.String }),
  ),
})

// The vocabulary ships with this package; a file that does not fit the schema is a build mistake
// the server must not start with, so the load fails loudly instead of checking nothing.
const words = Result.getOrThrow(Schema.decodeResult(SystemWords)(vocabulary)).words.map((word) => ({
  id: word.id,
  pattern: new RegExp(word.pattern, 'iu'),
}))

/** Every word's id: the closed set a count may name, so no reply text ever leaves in telemetry. */
export const systemWordIds: ReadonlyArray<string> = words.map((word) => word.id)

/**
 * The ids of the system words a reply used. Fenced blocks are skipped first: code the Person asked
 * for is not conversation, and an OpenUI display is checked by its own rules (`agents/displays.ts`).
 */
export function leaks(reply: string): ReadonlyArray<string> {
  const spoken = reply.replaceAll(/```[\s\S]*?```/gu, ' ')
  return words.filter((word) => word.pattern.test(spoken)).map((word) => word.id)
}

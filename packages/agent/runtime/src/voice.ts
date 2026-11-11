import { Effect, Result, Schema } from 'effect'
import vocabulary from './agents/system.json' with { type: 'json' }

/**
 * The system words Vivid must translate before a Person hears them (`agents/system.json`), with
 * what to say instead. The same file feeds `scripts/plain.mjs`, which fails the gate on any
 * Person sentence the code writes with one of these words, so the check on code and the callout
 * on live replies can never disagree about the vocabulary.
 */
const SystemWords = Schema.Struct({
  about: Schema.String,
  words: Schema.Array(Schema.Struct({ pattern: Schema.String, instead: Schema.String })),
})

// The vocabulary ships with this package; a file that does not fit the schema is a build mistake
// the runtime must not start with, so the load fails loudly instead of checking nothing.
const words = Result.getOrThrow(Schema.decodeResult(SystemWords)(vocabulary)).words.map(
  (word) => ({ pattern: new RegExp(word.pattern, 'iu'), source: word.pattern }),
)

/**
 * The system words a reply used, by their pattern in `agents/system.json`. Code blocks the Person
 * asked for are not conversation, so fenced blocks are skipped before matching (an OpenUI display
 * is one too: its wording is checked by its own renderer, not here).
 */
export function leaks(reply: string): ReadonlyArray<string> {
  const spoken = reply.replaceAll(/```[\s\S]*?```/gu, ' ')
  return words.filter((word) => word.pattern.test(spoken)).map((word) => word.source)
}

/**
 * The production callout: a reply that leaked a system word is logged as a warning naming only
 * the patterns, never the reply, so Sentry counts the leaks per word without carrying a Person's
 * words. It changes nothing the Person sees; it is how a regression in the voice is noticed
 * before the Person has to say "it talks like an engineer" again (Konan, 11 November 2026).
 */
export const calloutLeaks = Effect.fn('Voice.calloutLeaks')(function* (reply: string) {
  const found = leaks(reply)
  if (found.length === 0) return
  yield* Effect.logWarning('Reply used system words').pipe(
    Effect.annotateLogs({ words: found.join(' | '), count: found.length }),
  )
})

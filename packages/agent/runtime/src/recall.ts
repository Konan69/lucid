import type { Harness } from '@earendil-works/pi-durable'
import {
  MessageHit,
  RuntimeSearchAnswer,
  type MessageAuthor,
  type RuntimeSearchBody,
  type ThreadId,
} from '@vivid/contracts'
import { Array as Arr, Effect, Option, Order } from 'effect'
import { whole } from './state/link.ts'
import type { Projected } from './state/project.ts'
import type { PiRejected } from './threads.ts'

/**
 * Finding and reading what was said in the Person's other conversations.
 *
 * Each Thread keeps its own transcript in Pi, and work done in one may not have reached memory
 * (Muse `muse/workspace/system/system_prompt.md:304`: "Each chat keeps its own transcript, and work
 * done in one chat may not have reached memory yet"). Muse reads one chat at a time
 * (`chat.list`, `chat.read_messages`, paged backward); Dots also searches its history
 * (`dot_voice.search_messages`, `dots/voice.md:37`); Muse's app searches every chat's words
 * (`muse/docs/client-surfaces.md:133`). Here both read the transcript where Pi keeps it, through
 * the same projection the screens draw (`state/link.ts` `whole`), so a found message has the id a
 * screen opens the Thread on and nothing is copied out of Pi into another store.
 *
 * Only words the Person sees count: their own messages and Vivid's replies, as text. Signals,
 * advisories, reasoning and tool calls are left out, as Muse leaves hidden system and background
 * messages out of its index.
 */

/** One message as words: who said it, when (where the conversation stamps it), and the text. */
export interface Said {
  readonly id: string
  readonly author: MessageAuthor
  readonly at: Option.Option<string>
  readonly text: string
}

type Shown = Projected['messages'][number]

/** A visible message's author; none for what a Person does not read as someone speaking. */
const authorOf = (message: Shown): Option.Option<MessageAuthor> => {
  if (message.display !== 'visible') return Option.none()
  if (message.purpose === 'user') return Option.some('Person')
  if (message.purpose === 'assistant') return Option.some('Vivid')
  return Option.none()
}

/** The message's words, its text parts in order. A reply of only tool cards has none. */
const textOf = (message: Shown) =>
  message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim()

/** What the Person and Vivid said in one Thread, oldest first. A Thread never spoken in has none. */
const saidIn: (
  harness: Harness,
  threadId: ThreadId,
) => Effect.Effect<ReadonlyArray<Said>, PiRejected> = Effect.fn('Recall.saidIn')(function* (
  harness: Harness,
  threadId: ThreadId,
) {
  const state = yield* whole(harness, threadId)
  return Arr.getSomes(
    state.messages.map((message) =>
      Option.flatMap(authorOf(message), (author) => {
        const text = textOf(message)
        if (text.length === 0) return Option.none<Said>()
        return Option.some<Said>({
          id: message.id,
          author,
          at: Option.fromUndefinedOr(message.timestamp),
          text,
        })
      }),
    ),
  )
})

/** Letters and digits in any script; everything else separates words. */
const WORD = /[\p{L}\p{N}]+/gu

/** The words of a text, lowercased, with where each starts. */
const wordsOf = (text: string) =>
  Array.from(text.toLocaleLowerCase().matchAll(WORD), (match) => ({
    word: match[0],
    index: match.index,
  }))

/**
 * Muse's matching rule (`muse/docs/client-surfaces.md:133`): case-insensitive whole words, and the
 * last word typed also matches as a prefix, so results appear as the Person types. Every word of
 * the query must be in the message. A query with no letters or digits matches nothing.
 */
const matcher = (query: string) => {
  const terms = wordsOf(query).map(({ word }) => word)
  const last = terms.length - 1
  const hits = (term: string, position: number, word: string) =>
    position === last ? word.startsWith(term) : word === term
  return {
    matches: (text: string) => {
      if (terms.length === 0) return false
      const words = wordsOf(text)
      return terms.every((term, position) => words.some(({ word }) => hits(term, position, word)))
    },
    /** Where the first matching word of a text starts. */
    firstAt: (text: string) =>
      Arr.findFirst(wordsOf(text), ({ word }) =>
        terms.some((term, position) => hits(term, position, word)),
      ).pipe(Option.map(({ index }) => index)),
  }
}

/** How much of a message a snippet carries before and after its first match, in characters. */
const BEFORE = 60
const AFTER = 140

/** The words around the first match on one line, marked where the message goes on. */
const snippetOf = (text: string, at: number) => {
  const start = Math.max(0, at - BEFORE)
  const end = Math.min(text.length, at + AFTER)
  const words = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${words}${end < text.length ? '…' : ''}`
}

/** A match before it is cut down to a hit: the Thread, the message, where its first match starts. */
interface Match {
  readonly threadId: ThreadId
  readonly message: Said
  readonly first: number
}

/** Newest first; a message the conversation did not stamp goes after every stamped one. */
const newestFirst = Order.mapInput(
  Order.flip(Option.makeOrder(Order.String)),
  (found: Match) => found.message.at,
)

/** The messages of one Thread the query matches. */
const matchesIn = (
  threadId: ThreadId,
  said: ReadonlyArray<Said>,
  query: ReturnType<typeof matcher>,
): ReadonlyArray<Match> =>
  Arr.getSomes(
    said.map((message) =>
      query.matches(message.text)
        ? Option.map(query.firstAt(message.text), (first) => ({ threadId, message, first }))
        : Option.none(),
    ),
  )

/** A match as the wire carries it, with the words around it. */
const hitOf = ({ threadId, message, first }: Match) => {
  const hit = {
    threadId,
    messageId: message.id,
    author: message.author,
    snippet: snippetOf(message.text, first),
  }
  return Option.match(message.at, {
    onNone: () => MessageHit.make(hit),
    onSome: (at) => MessageHit.make({ ...hit, at }),
  })
}

/**
 * Search the named Threads' words. The caller (the server, or a tool that asked the server)
 * names only Threads the Person may see; this cell holds only its own Person's conversations, so
 * a Thread of anyone else is simply not found here.
 */
export const searchSaid: (
  harness: Harness,
  body: RuntimeSearchBody,
) => Effect.Effect<RuntimeSearchAnswer, PiRejected> = Effect.fn('Recall.search')(function* (
  harness: Harness,
  body: RuntimeSearchBody,
) {
  const query = matcher(body.query)
  const found = yield* Effect.forEach(body.threadIds, (threadId) =>
    Effect.map(saidIn(harness, threadId), (said) => matchesIn(threadId, said, query)),
  )
  const hits = Arr.sort(found.flat(), newestFirst).slice(0, body.limit).map(hitOf)
  return RuntimeSearchAnswer.make({ hits })
})

/**
 * A page of one Thread, read backward as Muse reads a chat ("page backward as needed",
 * `muse/workspace/system/system_prompt.md:172`) and as Codex's `read_thread` pages older turns
 * with a cursor (`gpt-6-astra/gpt-6-astra.md:1368`). `before` is the position the previous page
 * started at; none reads the newest messages. `earlier` is where the next older page ends, none
 * once the start of the Thread is reached.
 */
export const readSaid: (
  harness: Harness,
  threadId: ThreadId,
  before: Option.Option<number>,
  limit: number,
) => Effect.Effect<
  { readonly messages: ReadonlyArray<Said>; readonly earlier: Option.Option<number> },
  PiRejected
> = Effect.fn('Recall.read')(function* (
  harness: Harness,
  threadId: ThreadId,
  before: Option.Option<number>,
  limit: number,
) {
  const said = yield* saidIn(harness, threadId)
  const end = Math.min(
    said.length,
    Option.getOrElse(before, () => said.length),
  )
  const start = Math.max(0, end - limit)
  return {
    messages: said.slice(start, end),
    earlier: start > 0 ? Option.some(start) : Option.none<number>(),
  }
})

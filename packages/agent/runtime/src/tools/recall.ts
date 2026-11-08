import type { Harness } from '@earendil-works/pi-durable'
import { RuntimeSearchBody, Tool, type PersonId, type Thread } from '@vivid/contracts'
import { Effect, Option, Result } from 'effect'
import * as v from 'valibot'
import { readSaid, searchSaid, type Said } from '../recall.ts'
import { summary, text } from './inputs.ts'
import { catalog, named } from './names.ts'
import type { ToolResult } from './result.ts'
import { Scope, type RunTool } from './scope.ts'
import { defineTool } from './tool.ts'
import { modelText } from './views.ts'

/**
 * The cell these tools read: whose conversations it holds, and their Pi store once it is open.
 * A Thread lives in its creator's store, so this cell holds exactly the Threads its Person made.
 */
export interface Transcripts {
  readonly person: PersonId
  readonly harness: Effect.Effect<Harness>
}

/** The most messages one read returns; the tool output keeps at most 25 list items. */
const READ_MOST = 20
/** The most characters of one message a read returns; the rest is marked as cut. */
const MESSAGE_LONGEST = 1500

/** A refusal the model can say plainly; nothing was read. */
const refused = (message: string): ToolResult => ({ output: { ok: false, message } })

/**
 * The Person's own Threads under the names the model uses, or why they cannot be read. Only the
 * Person whose conversations these are may have them read: in a Thread shared with someone else,
 * a message from that someone must not open its creator's other conversations (Vivid's rule
 * "Do not quote one person's private memory, files or accounts to the others", `agents/vivid.ts`).
 * The server's list is the visibility authority: a deleted Thread is not in it, and only Threads
 * this Person created are in this cell. Names come from titles, made distinct by the Thread's
 * immutable id (`catalog`), so the same Thread keeps its name from one call to the next and no
 * identifier reaches the model.
 */
const ownThreads = Effect.fn('RecallTools.threads')(function* (transcripts: Transcripts) {
  const scope = yield* Scope
  if (scope.acting.personId !== transcripts.person) return Option.none()
  const listed = yield* scope.client.ListThreads()
  const own = listed.threads.filter((thread) => thread.createdBy.id === transcripts.person)
  return Option.some({
    current: scope.acting.threadId,
    named: catalog(own, (thread) => modelText(thread.title)),
  })
})

const NOT_YOURS =
  'Only the person whose conversations these are can have them searched or read; this message is from someone else.'
const UNREADABLE = 'Earlier conversations could not be read right now. Try again in a moment.'

/**
 * A message as the model reads it: who said it, when (null where the conversation stamped no
 * time), and its words, with `cut` saying they ran past what one read returns.
 */
const shown = (message: Said) => ({
  from: message.author,
  at: Option.getOrNull(message.at),
  text: modelText(message.text.slice(0, MESSAGE_LONGEST)),
  cut: message.text.length > MESSAGE_LONGEST,
})

/** Find messages in the Person's conversations by their words (Dots `search_messages`). */
function searchTool(runTool: RunTool, transcripts: Transcripts) {
  return defineTool({
    name: Tool.search_threads,
    description:
      'Search the words of the person’s earlier conversations, including this one, newest first. Matches whole words and the last word as a prefix. Returns each matching message’s conversation, who said it, when and an excerpt; read the conversation with read_thread for the full context.',
    input: v.object({
      summary,
      query: text('Words that would be in the message.', 200),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(20),
          v.description('Maximum messages to return.'),
        ),
        10,
      ),
    }),
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          const threads = yield* ownThreads(transcripts)
          if (Option.isNone(threads)) return refused(NOT_YOURS)
          const { current, named: inventory } = threads.value
          const harness = yield* transcripts.harness
          const byId = new Map<string, { readonly thread: Thread; readonly name: string }>(
            inventory.map(({ item, name }) => [item.id, { thread: item, name }]),
          )
          const found = yield* searchSaid(
            harness,
            RuntimeSearchBody.make({
              query: data.query,
              threadIds: inventory.map(({ item }) => item.id),
              limit: data.limit,
            }),
          ).pipe(
            Effect.asSome,
            Effect.catchTag('PiRejected', () => Effect.succeedNone),
          )
          if (Option.isNone(found)) return refused(UNREADABLE)
          const results = found.value.hits.flatMap((hit) => {
            const place = byId.get(hit.threadId)
            if (place === undefined) return []
            return [
              {
                thread: place.name,
                thisConversation: hit.threadId === current,
                from: hit.author,
                at: Option.getOrNull(Option.fromUndefinedOr(hit.at)),
                excerpt: modelText(hit.snippet),
              },
            ]
          })
          return { output: { results } }
        }),
        { signal, tool: Tool.search_threads },
      )
    },
  })
}

/** Read one of the Person's conversations, a page at a time (Muse `chat.read_messages`). */
function readTool(runTool: RunTool, transcripts: Transcripts) {
  return defineTool({
    name: Tool.read_thread,
    description:
      'Read the messages of one of the person’s conversations by its exact name from search_threads, newest page first. To read further back, call again with before set to the earlier value it returned; earlier is null at the start of the conversation.',
    input: v.object({
      summary,
      thread: text('Exact conversation name returned by search_threads.', 200),
      before: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description('The earlier value from the previous read, to page back.'),
        ),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(READ_MOST),
          v.description('Maximum messages to return.'),
        ),
        READ_MOST,
      ),
    }),
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          const threads = yield* ownThreads(transcripts)
          if (Option.isNone(threads)) return refused(NOT_YOURS)
          const thread = yield* Result.match(
            named(
              threads.value.named.map(({ item, name }) => ({ name, item })),
              data.thread,
            ),
            { onFailure: Effect.fail, onSuccess: Effect.succeed },
          )
          const harness = yield* transcripts.harness
          const page = yield* readSaid(
            harness,
            thread.id,
            Option.fromUndefinedOr(data.before),
            data.limit,
          ).pipe(
            Effect.asSome,
            Effect.catchTag('PiRejected', () => Effect.succeedNone),
          )
          if (Option.isNone(page)) return refused(UNREADABLE)
          // `earlier` is null once the page reaches the start of the conversation.
          return {
            output: {
              thread: data.thread,
              messages: page.value.messages.map(shown),
              earlier: Option.getOrNull(page.value.earlier),
            },
          }
        }),
        { signal, tool: Tool.read_thread },
      )
    },
  })
}

/** Search the Person's other conversations, and read one, to recover earlier work and words. */
export function recallTools(runTool: RunTool, transcripts: Transcripts) {
  return [searchTool(runTool, transcripts), readTool(runTool, transcripts)] as const
}

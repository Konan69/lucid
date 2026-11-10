import { Cause, Context, Effect, Layer, Option, Schema } from 'effect'
import type { NotFound, PersonId, ThreadId } from '@vivid/contracts'
import {
  ThreadTitleHistoryUnavailable,
  ThreadTitleModelUnavailable,
  ThreadTitleOutputInvalid,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { readConversationHistory, textOf } from '../runtime/history.ts'
import { TitleModel } from './model.ts'
import { Runtime } from '../runtime/client.ts'
import { findThread, requireThread, type StoredThread } from './access.ts'
import { ThreadStore } from './store.ts'
import {
  buildThreadTitlePrompt,
  canReplaceThreadTitle,
  DEFAULT_THREAD_TITLE,
  formatThreadTitleContext,
  sanitizeThreadTitle,
  type TitleMessage,
  TitleOutput,
} from './title.ts'

/** Bound provider work independently of the history read for both background naming and the awaited RPC. */
const TITLE_MODEL_TIMEOUT = '30 seconds'

type TitleFailure =
  | ThreadTitleHistoryUnavailable
  | ThreadTitleModelUnavailable
  | ThreadTitleOutputInvalid
const decodeTitle = Schema.decodeUnknownEffect(Schema.fromJsonString(TitleOutput), {
  onExcessProperty: 'error',
})
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)
const document = Schema.toJsonSchemaDocument(TitleOutput, {
  onExcessProperty: 'error',
})

export interface ThreadTitlesService {
  readonly afterRun: (thread: ThreadId) => Effect.Effect<void>
  readonly regenerate: (
    thread: StoredThread,
    person: PersonId,
  ) => Effect.Effect<string, TitleFailure | DatabaseInfrastructureError | NotFound>
}

/** Thread naming owns generation policy. The store owns guarded writes and publication; the runtime and TitleModel own I/O. */
export class ThreadTitles extends Context.Service<ThreadTitles, ThreadTitlesService>()(
  'vivid/ThreadTitles',
) {}

/** T3's formatThreadTitleContext adapted to conversation purposes. Routine and approval
 * dispatches are not Person messages. Shared messages and answers to Vivid's questions are. */
function titleMessages(
  history: Effect.Success<ReturnType<typeof readConversationHistory>>,
): ReadonlyArray<TitleMessage> {
  return history.messages.flatMap((message): ReadonlyArray<TitleMessage> => {
    if (
      message.purpose === 'user' ||
      (message.purpose === 'dispatch' &&
        message.signal !== undefined &&
        (message.signal.tagName === 'message' || message.signal.tagName === 'answer'))
    )
      return [{ role: 'user', text: textOf(message) }]
    if (message.purpose === 'assistant') return [{ role: 'assistant', text: textOf(message) }]
    return []
  })
}

/** T3 apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#maybeGenerateThreadTitleForFirstTurn and regenerateThreadTitle:
 * Vivid runs after settlement, uses the existing small model, and writes through provenance/snapshot guards. */
export const threadTitlesLayer = Layer.effect(
  ThreadTitles,
  Effect.gen(function* () {
    const database = yield* Database
    const runtime = yield* Runtime
    const model = yield* TitleModel
    const threads = yield* ThreadStore
    const withDatabase = Effect.provideService(Database, database)

    /** History failures never fall back to a partial or invented conversation. */
    const contents = Effect.fn('ThreadTitles.contents')(function* (thread: ThreadId) {
      const history = yield* readConversationHistory(runtime, thread).pipe(
        withDatabase,
        Effect.scoped,
        Effect.timeout('5 seconds'),
        Effect.mapError(() => ThreadTitleHistoryUnavailable.make({ thread })),
      )
      return titleMessages(history)
    })

    /** Use the title provider/schema protocol; invalid JSON or extra keys are a distinct failure. */
    const generate = Effect.fn('ThreadTitles.generate')(function* (
      thread: ThreadId,
      message: string,
      previous: Option.Option<string>,
    ) {
      const schema = yield* decodeJson({ ...document.schema, $defs: document.definitions }).pipe(
        Effect.mapError(() => ThreadTitleOutputInvalid.make({ thread })),
      )
      const built = buildThreadTitlePrompt(message, previous)
      const completion = yield* model
        .complete({ name: 'thread_title', prompt: built.prompt, content: built.content, schema })
        .pipe(
          Effect.timeout(TITLE_MODEL_TIMEOUT),
          Effect.mapError(() => ThreadTitleModelUnavailable.make({ thread })),
        )
      const result = yield* decodeTitle(completion.text).pipe(
        Effect.mapError(() => ThreadTitleOutputInvalid.make({ thread })),
      )
      return sanitizeThreadTitle(result.title)
    })

    /** T3's warning-only first-turn behavior; a failure is isolated from the settled Run. */
    const afterRun = Effect.fn('ThreadTitles.afterRun')(
      function* (id: ThreadId) {
        const found = yield* findThread(id).pipe(withDatabase)
        if (Option.isNone(found) || !canReplaceThreadTitle(found.value.titleSource)) return
        const messages = yield* contents(id)
        if (!messages.some((message) => message.role === 'user')) return
        const title = yield* generate(id, formatThreadTitleContext(messages), Option.none())
        if (title === DEFAULT_THREAD_TITLE) return
        yield* threads.generatedTitle(id, title, Option.none())
      },
      (effect, thread) =>
        effect.pipe(
          Effect.withErrorReporting,
          Effect.catchCause((cause) =>
            Effect.logWarning('Thread title generation failed', {
              thread,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
    )

    /** T3 regenerateThreadTitle supersede rule: a title changed during generation wins. No durable
     * request state is needed for this awaited RPC; same/default outputs remain unchanged as in T3. */
    const regenerate = Effect.fn('ThreadTitles.regenerate')(function* (
      thread: StoredThread,
      person: PersonId,
    ) {
      const messages = yield* contents(thread.id)
      const context = formatThreadTitleContext(messages)
      if (context.length === 0) return thread.title
      const title = yield* generate(thread.id, context, Option.some(thread.title))
      if (title !== DEFAULT_THREAD_TITLE && title !== thread.title) {
        yield* threads.generatedTitle(thread.id, title, Option.some(thread.title))
      }
      // Return current truth after a superseded write, including deletion/access revocation as typed failure.
      return (yield* requireThread(thread.id, person).pipe(withDatabase)).title
    })
    return ThreadTitles.of({ afterRun, regenerate })
  }),
)

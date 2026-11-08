import type { Context as PiContext } from '@earendil-works/chord'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  GenerationTask,
  hook,
  type EntryRecord,
  type GenerationHooks,
  type Harness,
  type HookApi,
} from '@earendil-works/pi-durable'
import { Effect } from 'effect'
import { pi } from './threads.ts'

/** Context edits keep recovered words in later model turns without changing Pi's aborted receipt. */
export const CONTINUATION_ENTRY = 'vivid.continuation'

/** Only recovery explicitly adopts a partial. A Person's Stop never writes this entry. */
export const continued = (entries: ReadonlyArray<EntryRecord>) =>
  new Set(
    entries.flatMap((entry) =>
      entry.kind === CONTINUATION_ENTRY && entry.edits !== undefined
        ? entry.edits.map((edit) => edit.target)
        : [],
    ),
  )

/** The interrupted generation's visible words, excluding unfinished tools and private thinking. */
const partialOf = (entry: EntryRecord, task: HookApi['taskId']) => {
  const [message] = entry.model === undefined ? [] : entry.model
  if (
    entry.byTaskId !== task ||
    message === undefined ||
    message.role !== 'assistant' ||
    message.stopReason !== 'aborted'
  )
    return []
  const content = message.content.flatMap((block) =>
    block.type === 'text' && block.text.length > 0
      ? [{ type: 'text' as const, text: block.text }]
      : [],
  )
  if (content.length === 0) return []
  return [
    { entry, message: { ...message, content, stopReason: 'stop' } satisfies AssistantMessage },
  ]
}

/**
 * Pi 1.4.0 converts a stored partial to an aborted entry before beforeRequest, then resends
 * the original cutoff without it. Adopt only this generation's partials. The context edit is
 * durable and replay-safe; the transient instruction asks for the suffix without adding a
 * synthetic Person message to the transcript. Later requests see the adopted words normally.
 */
const resume = Effect.fn('Continuity.resume')(function* (
  harness: Harness,
  api: HookApi,
  context: PiContext,
) {
  const conversation = yield* pi(() => harness.conversation(api.conversationId, context))
  if (conversation === undefined) return []
  const view = yield* pi(() => conversation.context(context))
  const partials = view.entries.flatMap((entry) => partialOf(entry, api.taskId))
  if (partials.length === 0) return []
  const adopted = continued(view.entries)
  const edits = partials
    .filter(({ entry }) => !adopted.has(entry.id))
    .map(({ entry, message }) => ({
      target: entry.id,
      action: 'replace' as const,
      messages: [message],
    }))
  const active = yield* pi(() =>
    // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the atomic Promise transaction callback and its handle.
    conversation.commit(async (tx) => {
      const task = await tx.task(api.taskId)
      if (task === undefined || task.abortRequested || task.state.status !== 'running') return false
      if (edits.length > 0)
        await tx.appendEntry(api.conversationId, { kind: CONTINUATION_ENTRY, edits })
      return true
    }, context),
  )
  return active ? partials.map(({ message }) => message) : []
})

/** Recovery stays inside Pi's generation task. Stop ends that task and cannot enter this hook. */
export const continuityHooks = (
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  harness: Effect.Effect<Harness>,
) =>
  hook(GenerationTask, {
    beforeRequest: (request, api, context): ReturnType<GenerationHooks['beforeRequest']> =>
      run(
        Effect.gen(function* () {
          const partials = yield* resume(yield* harness, api, context)
          const last = partials.at(-1)
          if (last === undefined) return undefined
          return {
            messages: [
              ...request.messages,
              { ...last, content: partials.flatMap((message) => message.content) },
              {
                role: 'user' as const,
                content:
                  'Your reply was interrupted. Continue immediately after the last character of your answer above. Write only the remaining text, without repeating or restarting the answer or mentioning the interruption.',
                timestamp: last.timestamp,
              },
            ],
          }
        }),
      ),
  })

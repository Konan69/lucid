import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AssistantEntry, UserEntry, type Harness } from '@earendil-works/pi-durable'
import { ensureConversation } from '@vivid/agent-runtime/cell'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Effect } from 'effect'

/**
 * Proof-only: give one Person a large history through Pi's own API, not raw SQL. Each Thread is
 * created by the runtime's `ensureConversation` (so the Thread mapping is the real one) and
 * filled with user and assistant entry pairs, committed `perCommit` pairs at a time through
 * `conversation.commit`. The assistant message is a real recorded reply (a template the driver
 * sends), with its text varied so rows are not identical.
 */
export interface SeedRequest {
  readonly from: number
  readonly threads: number
  readonly pairs: number
  readonly perCommit: number
  readonly assistant: AssistantMessage
}

export const seed = (harness: Harness, owner: PersonId, request: SeedRequest) =>
  Effect.gen(function* () {
    let entries = 0
    for (let t = request.from; t < request.from + request.threads; t += 1) {
      const conversation = yield* ensureConversation(harness, ThreadId.make(`seed-${t}`), {
        creator: owner,
        creatorName: 'Seed',
      })
      for (let p = 0; p < request.pairs; p += request.perCommit) {
        const count = Math.min(request.perCommit, request.pairs - p)
        yield* Effect.promise(() =>
          // @effect-diagnostics-next-line asyncFunction:off -- Pi's commit takes a Promise callback; this is its boundary.
          conversation.commit(async (tx) => {
            for (let i = 0; i < count; i += 1) {
              const n = p + i
              const at = Date.now()
              await tx.appendEntry(UserEntry, conversation.id, {
                model: [{ role: 'user', content: `Thread ${t}, question ${n}: tell me about topic ${n}.`, timestamp: at }],
              })
              await tx.appendEntry(AssistantEntry, conversation.id, {
                model: [
                  {
                    ...request.assistant,
                    content: request.assistant.content.map((block) =>
                      block.type === 'text' ? { ...block, text: `(${t}.${n}) ${block.text}` } : block,
                    ),
                    timestamp: at,
                  },
                ],
              })
            }
          }, BACKGROUND_CONTEXT),
        )
        entries += count * 2
      }
    }
    return { entries }
  })

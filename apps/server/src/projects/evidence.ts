import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  MessageId,
  ProjectEvidence,
  ProjectEvidenceMissing,
  ProjectProof,
  type ConversationState,
  type ProjectChange,
  type ProjectId,
  type ThreadId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Runtime } from '../runtime/client.ts'
import { readThreadHistory } from '../runtime/history.ts'
import { requireThread } from '../threads/access.ts'

type Message = ConversationState['messages'][number]
type Complete = Extract<ProjectChange, { readonly _tag: 'Complete' }>

const messageIdOf = Schema.decodeUnknownOption(MessageId)

/** The reply that holds this exact tool call: the Run the completion was asked from. */
const replyIndex = (messages: ReadonlyArray<Message>, toolCallId: string) =>
  messages.findIndex(
    (message) =>
      message.purpose === 'assistant' &&
      message.parts.some((part) => part.type === 'dynamic-tool' && part.toolCallId === toolCallId),
  )

/**
 * Which message the proof is. `vivid` is the reply itself, which holds what Vivid observed (its
 * tool results). `person` is the nearest Person message before it: the words that reply answers.
 * Either must carry a runtime message id (`MessageId`); an advisory or dispatch never is proof.
 */
const cited = (messages: ReadonlyArray<Message>, reply: number, said: Complete['said']) => {
  const chosen =
    said === 'vivid'
      ? Option.fromUndefinedOr(messages[reply])
      : Option.fromUndefinedOr(
          messages.slice(0, reply).findLast((message) => message.purpose === 'user'),
        )
  return Option.flatMap(chosen, (message) => messageIdOf(message.id))
}

/**
 * Resolve a completion to a proof that cites a message the caller can read. Only Vivid inside a
 * Run completes a Project: the server reads that Run's Thread, finds the reply holding the call
 * and cites the message the call names. Anything else, a Person's own call or a call that is not
 * in the conversation, leaves no source and is refused, so a Project is never done on a claim
 * nobody can open.
 */
export const resolveProof = Effect.fn('Projects.resolveProof')(function* (
  actor: Actor,
  id: ProjectId,
  change: Complete,
) {
  const missing = new ProjectEvidenceMissing({ id })
  if (Option.isNone(actor.threadId)) return yield* missing
  const threadId: ThreadId = actor.threadId.value
  yield* requireThread(threadId, actor.person.id)
  const history = yield* readThreadHistory(yield* Runtime, threadId)
  const reply = replyIndex(history.messages, change.toolCallId)
  if (reply < 0) return yield* missing
  const messageId = cited(history.messages, reply, change.said)
  if (Option.isNone(messageId)) return yield* missing
  return ProjectProof.make({
    summary: change.summary,
    sources: [ProjectEvidence.cases.ThreadMessage.make({ threadId, messageId: messageId.value })],
  })
})

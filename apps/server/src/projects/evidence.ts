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
type Confirm = Extract<ProjectChange, { readonly _tag: 'Confirm' }>

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
 * Resolve Vivid's completion to a proof that cites a message the caller can read: the server reads
 * the Run's Thread, finds the reply holding the call and cites the message the call names. A
 * `Complete` from outside a Run, or a call that is not in the conversation, leaves no source and
 * is refused, so Vivid never marks a Project done on a claim nobody can open. The Person marks it
 * done with `Confirm` (`confirmedProof`).
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

/**
 * The Person marking a Project done on its page: the proof is their own word, cited as them. Vivid
 * inside a Run completes only with `Complete`, which cites a message of that Run; a Run sending
 * `Confirm` would make a claim in the Person's name, so it is refused.
 */
export const confirmedProof = (actor: Actor, id: ProjectId, change: Confirm) =>
  Option.isSome(actor.threadId)
    ? Effect.fail(new ProjectEvidenceMissing({ id }))
    : Effect.succeed(
        ProjectProof.make({
          summary: change.summary,
          sources: [ProjectEvidence.cases.Person.make({ personId: actor.person.id })],
        }),
      )

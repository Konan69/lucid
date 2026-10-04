import type { Context } from '@earendil-works/chord'
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from '@earendil-works/pi-durable'
import type { UIMessageChunk } from 'ai'

import { initialRunState, replay, type RunState, translate } from './chunks.ts'

/** What a caller hands to a conversation: user input, with the id that makes a retry idempotent. */
export type RunInput = {
  readonly conversationId: ConversationId
  readonly content: string
  /** Same id after a retry or restart finds the same submission instead of submitting twice. */
  readonly requestId: string
}

/** Where the stream is, relative to the run that answers this input. */
type Phase = 'before' | 'inside' | 'after'

/**
 * Submit one input to a Pi Durable conversation and stream the run that answers it as AI SDK UI
 * message chunks.
 *
 * The event watch is attached before the submission is admitted. Attaching after would lose the
 * events committed between admission and attachment, because Pi Durable replays nothing.
 *
 * Only the run whose inputs include this submission is streamed. A busy conversation queues the
 * input as a follow-up, so events of the run in front of it are skipped, and the stream closes at
 * this run's end.
 */
export async function streamRun(
  harness: Harness,
  input: RunInput,
  context: Context,
): Promise<ReadableStream<UIMessageChunk>> {
  const conversation = await harness.conversation(input.conversationId, context)
  if (conversation === undefined) throw new Error(`Conversation ${input.conversationId} does not exist`)
  const events = await watchEvents(harness, input.conversationId, context)

  let phase: Phase = 'before'
  let state: RunState = initialRunState
  let submissionId: SubmissionId | undefined
  // Batches that arrive before `submit()` returns the submission id cannot be matched yet.
  const early: AgentEvent[] = []

  return new ReadableStream<UIMessageChunk>({
    start: async (controller) => {
      const apply = (event: AgentEvent, mine: SubmissionId) => {
        if (phase === 'before' && event.type === 'run_start' && event.inputs.includes(mine)) phase = 'inside'
        if (phase !== 'inside') return
        const step = translate(state, event)
        state = step.state
        for (const chunk of step.chunks) controller.enqueue(chunk)
        if (event.type === 'run_end') {
          phase = 'after'
          controller.close()
          void events.stop()
        }
      }
      events.start(async (batch) => {
        if (submissionId === undefined) early.push(...batch)
        else for (const event of batch) apply(event, submissionId)
      })
      const submission = await conversation.submit(
        { type: 'input', content: input.content, requestId: input.requestId },
        context,
      )
      submissionId = submission.id
      for (const event of early.splice(0)) apply(event, submission.id)
    },
    cancel: async () => {
      // A client that stops reading only detaches. The run is durable and continues.
      await events.stop()
    },
  })
}

/**
 * Attach to the run in progress on a conversation: first the chunks that rebuild its current state,
 * then its live events until it ends. This is what a reconnecting or late-joining client reads.
 * `undefined` means the conversation is idle, so there is nothing to resume.
 */
export async function attachRun(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<ReadableStream<UIMessageChunk> | undefined> {
  const events = await watchEvents(harness, conversationId, context)
  const prefix = replay(events.snapshot)
  if (prefix === undefined) {
    await events.stop()
    return undefined
  }
  let state = prefix.state
  return new ReadableStream<UIMessageChunk>({
    start: (controller) => {
      for (const chunk of prefix.chunks) controller.enqueue(chunk)
      events.start(async (batch) => {
        for (const event of batch) {
          const step = translate(state, event)
          state = step.state
          for (const chunk of step.chunks) controller.enqueue(chunk)
          if (event.type === 'run_end') {
            controller.close()
            void events.stop()
            return
          }
        }
      })
    },
    cancel: async () => {
      await events.stop()
    },
  })
}

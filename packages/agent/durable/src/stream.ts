import type { Context } from '@earendil-works/chord'
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from '@earendil-works/pi-durable'
import type { UIMessageChunk } from 'ai'
import { Option } from 'effect'

import { type Desk, emptyRound, needsDesk, parked, present, type Round } from './calls.ts'
import {
  initialRunState,
  replay,
  replayAfter,
  type RunState,
  type Step,
  translate,
} from './chunks.ts'
import { Holds, planOf } from './holds.ts'

/** What a caller hands to a conversation: user input, with the id that makes a retry idempotent. */
export type RunInput = {
  readonly conversationId: ConversationId
  readonly content: string
  /** Same id after a retry or restart finds the same submission instead of submitting twice. */
  readonly requestId: string
}

type Controller = ReadableStreamDefaultController<UIMessageChunk>

/** The desk for a batch with no tool chunks: nothing to look up. */
const noDesk: Desk = { plan: () => Option.none(), settled: {} }

/** Read the conversation's current tools and settlements. Tools can change between turns. */
async function readDesk(
  harness: Harness,
  conversation: Conversation,
  context: Context,
): Promise<Desk> {
  const agent = await conversation.agent(context)
  const plans = new Map(
    agent.tools.flatMap((tool) => {
      const plan = planOf(tool)
      return plan === undefined ? [] : [[tool.name, plan] as const]
    }),
  )
  const holds = await harness.snapshot(Holds, conversation.id, context)
  return {
    plan: (toolName) => Option.fromNullishOr(plans.get(toolName)),
    settled: holds?.settled ?? {},
  }
}

/**
 * The writing end of one client stream: it translates events, presents the chunks, writes them, and
 * ends the stream when the run ends or parks.
 */
type Writer = {
  /** Write a replayed prefix. `settledRound`: no response is in flight, so a parked round is final. */
  readonly prefix: (step: Step, settledRound: boolean) => Promise<'open' | 'ended'>
  /** Apply one live event. */
  readonly event: (event: AgentEvent) => Promise<'open' | 'ended'>
  /** Finish a stream whose run is already over. */
  readonly finish: () => void
}

function writer(
  harness: Harness,
  conversation: Conversation,
  events: AgentEventStream,
  controller: Controller,
  context: Context,
): Writer {
  let state: RunState = initialRunState
  let round: Round = emptyRound
  const end = () => {
    controller.close()
    void events.stop()
  }
  const write = async (chunks: readonly UIMessageChunk[]) => {
    const desk = needsDesk(chunks) ? await readDesk(harness, conversation, context) : noDesk
    const shown = present(round, chunks, desk)
    round = shown.round
    for (const chunk of shown.chunks) controller.enqueue(chunk)
  }
  /** The run waits for a person: finish the client's stream, leave the run in progress. */
  const park = () => {
    controller.enqueue({ type: 'finish-step' })
    controller.enqueue({ type: 'finish' })
    end()
    return 'ended' as const
  }
  return {
    prefix: async (step, settledRound) => {
      state = step.state
      await write(step.chunks)
      return settledRound && parked(round) ? park() : 'open'
    },
    event: async (event) => {
      const step = translate(state, event)
      state = step.state
      await write(step.chunks)
      if (event.type === 'run_end') {
        end()
        return 'ended'
      }
      // A round is complete only when its response has ended; while the response still streams, a
      // later call of the same round may not have been seen yet.
      const roundSettled = event.type === 'message_end' || event.type === 'tool_execution_end'
      return roundSettled && parked(round) ? park() : 'open'
    },
    finish: () => {
      controller.enqueue({ type: 'finish' })
      end()
    },
  }
}

async function existing(harness: Harness, conversationId: ConversationId, context: Context) {
  const conversation = await harness.conversation(conversationId, context)
  if (conversation === undefined) throw new Error(`Conversation ${conversationId} does not exist`)
  return conversation
}

/** Feed live event batches to `write` until the stream ends. */
function follow(events: AgentEventStream, write: Writer) {
  let ended = false
  events.start(async (batch) => {
    for (const event of batch) {
      if (ended) return
      ended = (await write.event(event)) === 'ended'
    }
  })
}

/**
 * Submit one input to a Pi Durable conversation and stream the run that answers it as AI SDK UI
 * message chunks.
 *
 * The event watch is attached before the submission is admitted. Attaching after would lose the
 * events committed between admission and attachment, because Pi Durable replays nothing.
 *
 * Only the run whose inputs include this submission is streamed. A busy conversation queues the
 * input as a follow-up, so events of the run in front of it are skipped. The stream closes at this
 * run's end, or earlier when the run waits for a person: see `parked`.
 */
export async function streamRun(
  harness: Harness,
  input: RunInput,
  context: Context,
): Promise<ReadableStream<UIMessageChunk>> {
  const conversation = await existing(harness, input.conversationId, context)
  const events = await watchEvents(harness, input.conversationId, context)

  return new ReadableStream<UIMessageChunk>({
    start: async (controller) => {
      const write = writer(harness, conversation, events, controller, context)
      let phase: 'before' | 'inside' | 'after' = 'before'
      let submissionId: SubmissionId | undefined
      // Batches that arrive before `submit()` returns the submission id cannot be matched yet.
      const early: AgentEvent[] = []
      const apply = async (event: AgentEvent, mine: SubmissionId) => {
        if (phase === 'before' && event.type === 'run_start' && event.inputs.includes(mine))
          phase = 'inside'
        if (phase !== 'inside') return
        if ((await write.event(event)) === 'ended') phase = 'after'
      }
      events.start(async (batch) => {
        if (submissionId === undefined) early.push(...batch)
        else for (const event of batch) await apply(event, submissionId)
      })
      const submission = await conversation.submit(
        { type: 'input', content: input.content, requestId: input.requestId },
        context,
      )
      submissionId = submission.id
      for (const event of early.splice(0)) await apply(event, submission.id)
    },
    cancel: async () => {
      // A client that stops reading only detaches. The run is durable and continues.
      await events.stop()
    },
  })
}

/**
 * Attach to the run in progress on a conversation: first the chunks that rebuild its current state,
 * then its live events until it ends or parks. This is what a reconnecting or late-joining client
 * with no copy of the run reads. `undefined` means the conversation is idle.
 */
export async function attachRun(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<ReadableStream<UIMessageChunk> | undefined> {
  const conversation = await existing(harness, conversationId, context)
  const events = await watchEvents(harness, conversationId, context)
  const prefix = Option.getOrUndefined(replay(events.snapshot))
  if (prefix === undefined) {
    await events.stop()
    return undefined
  }
  const settledRound = events.snapshot.generation?.message === undefined
  return new ReadableStream<UIMessageChunk>({
    start: async (controller) => {
      const write = writer(harness, conversation, events, controller, context)
      if ((await write.prefix(prefix, settledRound)) === 'open') follow(events, write)
    },
    cancel: async () => {
      await events.stop()
    },
  })
}

/**
 * Continue a run for a client that already shows its tool calls `known` and has just settled a
 * hold: the results of those calls, the steps after them, and the live events until the run ends or
 * parks again. A run that ended in the meantime is replayed to its end.
 *
 * `undefined` means no assistant message of the conversation made those calls.
 */
export async function continueRun(
  harness: Harness,
  conversationId: ConversationId,
  known: ReadonlySet<string>,
  context: Context,
): Promise<ReadableStream<UIMessageChunk> | undefined> {
  const conversation = await existing(harness, conversationId, context)
  const events = await watchEvents(harness, conversationId, context)
  const prefix = Option.getOrUndefined(replayAfter(events.snapshot, known))
  if (prefix === undefined) {
    await events.stop()
    return undefined
  }
  const settledRound = events.snapshot.generation?.message === undefined
  return new ReadableStream<UIMessageChunk>({
    start: async (controller) => {
      const write = writer(harness, conversation, events, controller, context)
      if ((await write.prefix(prefix.step, settledRound)) === 'ended') return
      if (prefix.live) follow(events, write)
      else write.finish()
    },
    cancel: async () => {
      await events.stop()
    },
  })
}

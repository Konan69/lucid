import type { Context } from '@earendil-works/chord'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { type ConversationId, type Harness, LiveDoc } from '@earendil-works/pi-durable'

import { holdKind, Holds, planOf } from './holds.ts'

/**
 * A tool call that waits for a person.
 *
 * - `approval`: approve or deny it with `decide`.
 * - `answer`: the model waits inside the call for its result; supply it with `answer`.
 * - `later`: the call returned and the model moved on; `answer` delivers the result as a message.
 */
export type Waiting = {
  readonly kind: 'approval' | 'answer' | 'later'
  readonly callId: string
  readonly toolName: string
  /** The call's arguments. Absent for a `later` call, whose round is over. */
  readonly input?: unknown
}

type ToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>

/**
 * Every tool call of a conversation that waits for a person, read from durable state only, so the
 * answer is the same before and after a restart and with no client attached.
 *
 * Nothing records "this call is waiting": the hook that waits can only read. A waiting call is
 * therefore derived: a call of the current round that has not started (`pending`), whose tool's
 * plan holds it, and that has no settlement yet.
 */
export async function waiting(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<readonly Waiting[]> {
  const conversation = await harness.conversation(conversationId, context)
  if (conversation === undefined) throw new Error(`Conversation ${conversationId} does not exist`)
  const holds = await harness.snapshot(Holds, conversationId, context)
  const later = Object.entries(holds?.asked ?? {}).map(
    ([callId, toolName]): Waiting => ({ kind: 'later', callId, toolName }),
  )
  const live = await harness.snapshot(LiveDoc, conversationId, context)
  const pending = (live?.tools ?? []).filter((slot) => slot.status === 'pending')
  if (pending.length === 0) return later

  const agent = await conversation.agent(context)
  const view = await conversation.context(context)
  const calls = new Map(
    view.entries.flatMap((entry) => {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') return []
      return message.content.flatMap((block) => (block.type === 'toolCall' ? [[block.id, block] as const] : []))
    }),
  )
  const held = pending.flatMap((slot): Waiting[] => {
    const tool = agent.tools.find((each) => each.name === slot.name)
    const plan = tool === undefined ? undefined : planOf(tool)
    const call: ToolCall | undefined = calls.get(slot.callId)
    if (plan === undefined || call === undefined || holds?.settled[slot.callId] !== undefined) return []
    const kind = holdKind(plan, call.arguments)
    return kind === undefined ? [] : [{ kind, callId: slot.callId, toolName: slot.name, input: call.arguments }]
  })
  return [...held, ...later]
}

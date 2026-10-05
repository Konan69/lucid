import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import { type ConversationId, type Harness, LiveDoc } from '@earendil-works/pi-durable'

import { Array as Arr, Effect, Option } from 'effect'

import { applicable, holdKind, Holds, planOf } from './holds.ts'
import * as Pi from './pi.ts'

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
  readonly input?: JsonValue
}

/**
 * Every tool call of a conversation that waits for a person, read from durable state only, so the
 * answer is the same before and after a restart and with no client attached.
 *
 * Nothing records "this call is waiting": the hook that waits can only read. A waiting call is
 * therefore derived: a call of the current round that has not started (`pending`), whose tool's
 * plan holds it, and that has no settlement yet.
 */
export const waiting = Effect.fn('Durable.waiting')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const holds = yield* Pi.snapshot(harness, Holds, conversationId, context)
  const later = Object.entries(
    Option.match(holds, { onNone: () => ({}), onSome: (document) => document.asked }),
  ).map(([callId, toolName]): Waiting => ({
    kind: 'later',
    callId,
    toolName,
  }))
  const live = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
  const pending = Option.match(live, {
    onNone: () => [],
    onSome: (document) => document.tools ?? [],
  }).filter((slot) => slot.status === 'pending')
  if (pending.length === 0) return later

  const agent = yield* Pi.agent(conversation, context)
  const view = yield* Pi.view(conversation, context)
  const calls = new Map(
    view.entries.flatMap((entry) => {
      const message = Option.fromNullishOr(entry.model).pipe(Option.flatMap(Arr.head))
      if (Option.isNone(message) || message.value.role !== 'assistant') return []
      return message.value.content.flatMap((block) =>
        block.type === 'toolCall' ? [[block.id, block] as const] : [],
      )
    }),
  )
  const held = pending.flatMap((slot): Waiting[] => {
    const tool = agent.tools.find((each) => each.name === slot.name)
    const plan = Option.fromNullishOr(tool).pipe(Option.flatMap(planOf))
    const call = Option.fromNullishOr(calls.get(slot.callId))
    const settled = applicable(
      holds.pipe(Option.flatMapNullishOr((document) => document.settled[slot.callId])),
      Option.some(slot),
    )
    if (Option.isNone(plan) || Option.isNone(call) || Option.isSome(settled)) return []
    // Pi AI exposes readonly JSON while chord owns the mutable JSON used by hold contracts.
    const input = copyJson(call.value.arguments)
    const kind = holdKind(plan.value, input)
    return Option.isNone(kind)
      ? []
      : [
          {
            kind: kind.value,
            callId: slot.callId,
            toolName: slot.name,
            input,
          },
        ]
  })
  return [...held, ...later]
})

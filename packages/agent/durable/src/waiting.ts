import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import { type ConversationId, type Harness, LiveDoc } from '@earendil-works/pi-durable'

import { Array as Arr, Effect, Option } from 'effect'

import {
  CallIdentity,
  CallLookup,
  callsIn,
  lookupSnapshots,
  holdKind,
  Holds,
  planOf,
} from './holds.ts'
import { HoldId } from './errors.ts'
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
  readonly holdId: HoldId
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
 * therefore derived: a unique pending call of the current round with an allocated task id, whose
 * tool's plan holds it, and that has no settlement for that task yet.
 */
export const waiting = Effect.fn('Durable.waiting')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const holds = yield* Pi.snapshot(harness, Holds, conversationId, context)
  const live = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
  const agent = yield* Pi.agent(conversation, context)
  const view = yield* Pi.view(conversation, context)
  const callIds = new Set(
    Option.match(live, {
      onNone: () => [],
      onSome: (document) => (document.tools ?? []).map((slot) => slot.callId),
    }),
  )
  const later = Option.match(holds, {
    onNone: (): Waiting[] => [],
    onSome: (document) =>
      Object.keys(document.asked).flatMap((key): Waiting[] => {
        const holdId = HoldId.make(key)
        const found = lookupSnapshots(live, holds, CallIdentity.cases.Hold.make({ holdId }))
        return CallLookup.guards.Asked(found)
          ? [{ kind: 'later', holdId, callId: found.callId, toolName: found.toolName }]
          : []
      }),
  })
  const current = Array.from(callIds).flatMap((callId): Waiting[] => {
    const found = lookupSnapshots(
      live,
      holds,
      CallIdentity.cases.Public.make({ callId, resultTask: Option.none(), duplicate: false }),
    )
    if (!CallLookup.guards.Ready(found)) return []
    const entry = view.entries.findLast((candidate) => callsIn(candidate, callId).length > 0)
    if (entry === undefined) return []
    const call = Option.fromNullishOr(callsIn(entry, callId)).pipe(Option.flatMap(Arr.head))
    if (Option.isNone(call)) return []
    const tool = agent.tools.find((each) => each.name === call.value.name)
    const plan = Option.fromNullishOr(tool).pipe(Option.flatMap(planOf))
    if (Option.isNone(plan)) return []
    const input = copyJson(call.value.arguments)
    const kind = holdKind(plan.value, input)
    return Option.isNone(kind)
      ? []
      : [{ kind: kind.value, holdId: found.holdId, callId, toolName: call.value.name, input }]
  })
  return [...current, ...later]
})

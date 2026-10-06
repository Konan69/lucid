import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import { type ConversationId, type Harness, LiveDoc } from '@earendil-works/pi-durable'

import { Effect, Option } from 'effect'

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
import { questionOpen } from './answers.ts'

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
export const waiting: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<
  Waiting[],
  import('./errors.ts').ConversationMissing | import('./errors.ts').PiFailed,
  never
> = Effect.fn('Durable.waiting')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const holds = yield* Pi.snapshot(harness, Holds, conversationId, context)
  const live = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
  const callIds = new Set(
    Option.match(live, {
      onNone: () => [],
      onSome: (document) => (document.tools ?? []).map((slot) => slot.callId),
    }),
  )
  const later: Waiting[] = []
  if (Option.isSome(holds)) {
    for (const [key, question] of Object.entries(holds.value.asked)) {
      const holdId = HoldId.make(key)
      const found = lookupSnapshots(live, holds, CallIdentity.cases.Hold.make({ holdId }))
      if (
        CallLookup.guards.Asked(found) &&
        (yield* questionOpen(harness, conversation, question, context))
      )
        later.push({ kind: 'later', holdId, callId: found.callId, toolName: found.toolName })
    }
  }
  const ready = [...callIds].flatMap((callId) => {
    const found = lookupSnapshots(
      live,
      holds,
      CallIdentity.cases.Public.make({ callId, resultTask: Option.none(), duplicate: false }),
    )
    return CallLookup.guards.Ready(found) ? [found] : []
  })
  if (ready.length === 0) return later
  // Pending slots contain no arguments. One context read indexes all current inputs together;
  // idle/later-only observations need neither context nor registry authority.
  const agent = yield* Pi.agent(conversation, context)
  const view = yield* Pi.view(conversation, context)
  const inputs = new Map(view.entries.flatMap(callsIn).map((call) => [call.id, call]))
  const current = ready.flatMap((found): Waiting[] => {
    const callId = found.callId
    const call = Option.fromNullishOr(inputs.get(callId))
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

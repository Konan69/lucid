import type * as Errors from './errors.ts'
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import { type ConversationId, type Harness, LiveDoc } from '@earendil-works/pi-durable'

import { Effect, Option } from 'effect'

import {
  CallIdentity,
  CallLookup,
  callsIn,
  lookupSnapshots,
  decision,
  taskDecision,
  CallDecision,
  Holds,
  planOf,
} from './holds.ts'
import { HoldId, PiFailed } from './errors.ts'
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
) => Effect.Effect<Waiting[], Errors.ConversationMissing | Errors.PiFailed> = Effect.fn(
  'Durable.waiting',
)(function* (harness: Harness, conversationId: ConversationId, context: Context) {
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
  const current = yield* Effect.forEach(ready, (found) =>
    waitingCall({ harness, agent, inputs, context }, found),
  )
  return [...current.flat(), ...later]
})

/** Pull readers can see a hook's live task memo; only calls not yet pinned evaluate the shared rule. */
const waitingCall = Effect.fn('Durable.waitingCall')(function* (
  reader: {
    harness: Harness
    agent: Awaited<ReturnType<import('@earendil-works/pi-durable').Conversation['agent']>>
    inputs: ReadonlyMap<string, import('@earendil-works/pi-ai').ToolCall>
    context: Context
  },
  found: typeof CallLookup.cases.Ready.Type,
): Effect.fn.Return<Waiting[], PiFailed> {
  const call = reader.inputs.get(found.callId)
  if (call === undefined) return []
  const stored = yield* taskDecision(reader.harness, found.taskId, reader.context)
  const tool = reader.agent.tools.find((each) => each.name === call.name)
  const plan = Option.fromNullishOr(tool).pipe(Option.flatMap(planOf))
  if (Option.isNone(stored) && Option.isNone(plan)) return []
  const chosen = Option.isSome(stored)
    ? stored.value
    : yield* Option.match(plan, {
        onNone: () => Effect.succeed(CallDecision.cases.Free.make({})),
        onSome: (value) => decision(value, call),
      })
  return CallDecision.guards.Held(chosen)
    ? [
        {
          kind: chosen.kind,
          holdId: found.holdId,
          callId: found.callId,
          toolName: call.name,
          input: copyJson(call.arguments),
        },
      ]
    : []
})

import type { Context } from '@earendil-works/chord'
import type { Conversation, Harness, TaskId } from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import { Effect, Option, Schema } from 'effect'
import type { Desk, Round } from './calls.ts'
import type { Chunk } from './chunks.ts'
import {
  type CallState,
  CallIdentity,
  CallLookup,
  identitiesFor,
  lookupSnapshots,
  Holds,
  planOf,
  decision,
  CallDecision,
} from './holds.ts'
import { PiFailed, ToolNameDuplicated } from './errors.ts'
import * as Pi from './pi.ts'

export const noDesk: Desk = {
  sequential: false,
  decision: () => CallDecision.cases.Free.make({}),
  plan: () => Option.none(),
  origin: () => Option.none(),
  call: () => CallLookup.cases.Missing.make({}),
  hold: () => CallLookup.cases.Missing.make({}),
}

export type Reader = {
  readonly harness: Harness
  readonly conversation: Conversation
  readonly context: Context
}
/** Resolve tool plans at the point of presentation, since the registry can change between turns. */
export const readDesk = Effect.fn('Durable.readDesk')(function* (
  reader: Reader,
  observation: {
    readonly chunks: readonly Chunk[]
    readonly live: Option.Option<CallState>
    readonly origins: ReadonlyMap<Chunk, TaskId>
  },
  shownHolds: Round['holds'],
): Effect.fn.Return<Desk, PiFailed> {
  const { chunks, live: observedLive, origins } = observation
  const agent = yield* Pi.agent(reader.conversation, reader.context)
  // HookApi cannot resolve its selected registration. Reject ambiguity where the public agent can.
  const names = new Set(chunks.flatMap((chunk) => ('toolName' in chunk ? [chunk.toolName] : [])))
  for (const name of names) {
    const offered = agent.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter((tool) => tool.name === name)
    if (offered.length > 1 && offered.some((tool) => Option.isSome(planOf(tool))))
      return yield* new PiFailed({
        operation: 'agent',
        cause: new ToolNameDuplicated({ toolName: name }),
      })
  }
  const plans = new Map(
    agent.tools.flatMap((tool) => {
      const plan = planOf(tool)
      return Option.isNone(plan) ? [] : [[tool.name, plan.value] as const]
    }),
  )
  // Pi generation.js:436 combines the hidden host default with offered tool registrations. The
  // bridge makes both readable: plans declare the default and registrations state their modes.
  // Conservatively inspect the whole agent, since a later generated call cannot be un-shown.
  const execution = [...plans.values()].some((plan) => plan.execution === 'sequential')
    ? 'sequential'
    : 'parallel'
  const sequential = agent.tools.some((tool) => (tool.executionMode ?? execution) === 'sequential')
  const holds = yield* Pi.snapshot(reader.harness, Holds, reader.conversation.id, reader.context)
  const live = Option.isSome(observedLive)
    ? observedLive
    : yield* Pi.snapshot(reader.harness, LiveDoc, reader.conversation.id, reader.context)
  const callIds = new Set(
    chunks.flatMap((chunk) =>
      'toolCallId' in chunk && !origins.has(chunk) ? [chunk.toolCallId] : [],
    ),
  )
  // A slot, an in-flight generation call, or the hold previously shown to this reader can
  // answer without a transcript scan. Only a truly missing completed call needs provenance.
  const calls = new Map(
    [...callIds].map((callId) => {
      const identity = CallIdentity.cases.Public.make({
        callId,
        resultTask: Option.none(),
        duplicate: false,
      })
      const direct = lookupSnapshots(live, holds, identity)
      const shownHold = shownHolds.get(callId)
      const found =
        CallLookup.guards.Missing(direct) && shownHold !== undefined
          ? lookupSnapshots(live, holds, CallIdentity.cases.Hold.make({ holdId: shownHold }))
          : direct
      return [callId, found] as const
    }),
  )
  const unresolved = [...calls].flatMap(([id, found]) =>
    CallLookup.guards.Missing(found) ? [id] : [],
  )
  if (unresolved.length > 0) {
    const identities = identitiesFor((yield* Pi.view(reader.conversation, reader.context)).entries)
    for (const callId of unresolved) {
      const identity = identities.get(callId)
      if (identity !== undefined) calls.set(callId, lookupSnapshots(live, holds, identity))
    }
  }
  const decisions = yield* decisionsFor(chunks, { plans, calls, origins, holds })
  return {
    sequential,
    decision: (chunk) => decisions.get(chunk) ?? CallDecision.cases.Free.make({}),
    plan: (toolName: string) => Option.fromNullishOr(plans.get(toolName)),
    call: (callId: string) => calls.get(callId) ?? CallLookup.cases.Missing.make({}),
    origin: (chunk: Extract<Chunk, { toolCallId: string }>) =>
      Option.fromNullishOr(origins.get(chunk)).pipe(
        Option.map((taskId) =>
          lookupSnapshots(
            Option.some({ tools: [] }),
            holds,
            CallIdentity.cases.Public.make({
              callId: chunk.toolCallId,
              resultTask: Option.some(taskId),
              duplicate: false,
            }),
          ),
        ),
      ),
    hold: (holdId: import('./errors.ts').HoldId) =>
      lookupSnapshots(live, holds, CallIdentity.cases.Hold.make({ holdId })),
  } satisfies Desk
})

const decodeArguments = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.MutableJson))
/** Terminal provenance and settlements replace policy evaluation; only active calls need parsing. */
const decisionsFor = Effect.fn('Durable.presentationDecisions')(function* (
  chunks: readonly Chunk[],
  state: {
    plans: ReadonlyMap<string, import('./holds.ts').Plan>
    calls: ReadonlyMap<string, CallLookup>
    origins: ReadonlyMap<Chunk, TaskId>
    holds: Effect.Success<
      ReturnType<typeof Pi.snapshot<ReturnType<typeof Holds.definition.initial>>>
    >
  },
) {
  const decisions = new Map<Chunk, CallDecision>()
  for (const chunk of chunks) {
    if (chunk.type !== 'tool-input-available') continue
    const found = Option.getOrElse(
      Option.fromNullishOr(state.origins.get(chunk)).pipe(
        Option.map((taskId) =>
          lookupSnapshots(
            Option.some({ tools: [] }),
            state.holds,
            CallIdentity.cases.Public.make({
              callId: chunk.toolCallId,
              resultTask: Option.some(taskId),
              duplicate: false,
            }),
          ),
        ),
      ),
      () => state.calls.get(chunk.toolCallId) ?? CallLookup.cases.Missing.make({}),
    )
    // A terminal call's durable settlement is authoritative, independent of today's policy.
    if (CallLookup.guards.Settled(found)) {
      decisions.set(
        chunk,
        found.settlement.kind === 'answered'
          ? CallDecision.cases.Free.make({})
          : CallDecision.cases.Held.make({ kind: 'approval' }),
      )
      continue
    }
    if (
      state.origins.has(chunk) ||
      CallLookup.isAnyOf(['Executing', 'Done', 'Missing', 'Asked'])(found)
    ) {
      decisions.set(chunk, CallDecision.cases.Free.make({}))
      continue
    }
    const plan = Option.fromNullishOr(state.plans.get(chunk.toolName))
    decisions.set(
      chunk,
      Option.isNone(plan)
        ? CallDecision.cases.Free.make({})
        : yield* decision(plan.value, {
            type: 'toolCall',
            id: chunk.toolCallId,
            name: chunk.toolName,
            arguments: yield* decodeArguments(chunk.input).pipe(
              Effect.mapError((cause) => new PiFailed({ operation: 'snapshot', cause })),
            ),
          }),
    )
  }
  return decisions
})

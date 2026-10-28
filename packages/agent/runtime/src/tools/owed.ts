import { defineTool } from './tool.ts'
import {
  Tool,
  InvalidRequest,
  OwedState,
  TrackOwedRequest,
  UpdateOwedRequest,
  ResolveOwedRequest,
  DropOwedRequest,
  type Owed,
} from '@vivid/contracts'
import { DateTime, Effect, Option, Result } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { named } from './names.ts'
import { Scope, type RunTool } from './scope.ts'
import { modelText } from './views.ts'

const what = text('What is owed, exactly as the Person names it.', 240)
const from = text('Who owes it, as the Person names them. Never invent a party.', 120)
const nextStep = text('The next agreed step about this commitment.', 240)
const localTime = v.pipe(
  text(
    'Resolve the Person’s date words using the response clock into YYYY-MM-DDTHH:mm:ss in their context time zone. Never invent a date or time.',
    19,
  ),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u),
)

/** Resolve wall time in the response's context zone (`Scope`), never the host zone or an invented
 * UTC fallback. */
const instant = Effect.fn('OwedTools.instant')(function* (local: string) {
  const { timezone } = yield* Scope
  if (timezone.length === 0)
    return yield* new InvalidRequest({
      message: 'Ask the Person for their time zone before tracking dates.',
    })
  const time = DateTime.makeZoned(`${local}Z`, {
    timeZone: timezone,
    adjustForTimeZone: true,
    disambiguation: 'reject',
  })
  if (Option.isNone(time))
    return yield* new InvalidRequest({
      message: 'That local date or time is invalid or ambiguous. Ask the Person to clarify it.',
    })
  return DateTime.toEpochMillis(time.value)
})

/** Only names and the confirmed result enter model context; identifiers stay in the RPC client. */
const view = (record: Owed) => ({
  ok: true,
  what: modelText(record.what),
  from: modelText(record.from),
  since: record.since,
  due: record.due,
  blockedOn: record.blockedOn,
  nextStep: modelText(record.nextStep),
  state: OwedState.match(record.state, {
    Open: () => ({ status: 'open' }),
    Nudged: ({ lastAt, count }) => ({ status: 'nudged', lastAt, count }),
    Resolved: ({ at, how }) => ({ status: 'resolved', at, how: modelText(how) }),
    Dropped: ({ at, why }) => ({ status: 'dropped', at, why: modelText(why) }),
  }),
})

/** Exact what/from names resolve only open work. Missing or ambiguous input returns its inventory. */
const select = Effect.fn('OwedTools.select')(function* (input: { what: string; from: string }) {
  const { client } = yield* Scope
  const response = yield* client.ListOwed()
  const open = response.owed.filter((record) => OwedState.isAnyOf(['Open', 'Nudged'])(record.state))
  const selected = named(
    open
      .filter((record) => record.from.trim().toLowerCase() === input.from.trim().toLowerCase())
      .map((item) => ({ name: item.what, item })),
    input.what,
  )
  return yield* Result.match(selected, {
    onSuccess: Effect.succeed,
    onFailure: () =>
      Effect.fail(
        new InvalidRequest({
          message: `No unique open record matches those names. Choose exact what and from names from these open records: ${JSON.stringify(open.map((record) => ({ what: modelText(record.what), from: modelText(record.from) })))}`,
        }),
      ),
  })
})

/** Product persistence and access stay on the server. Scope supplies the Person's time zone. */
export function owedTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.track_owed,
      description:
        'Track what someone owes the Person when they say they are waiting on someone, or when you notice a promise or order in mail. Keep their words for what and who. Resolve since and any due date using their context clock and time zone. Use null when no due date was given. Never invent a party or a date. When it arrives, use resolve_owed.',
      input: v.strictObject({
        summary,
        what,
        from,
        since: localTime,
        due: v.nullable(localTime),
        nextStep,
      }),
      /** The current Thread and acting Person come from Scope, never model arguments. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client, acting } = yield* Scope
            const since = yield* instant(data.since)
            const due = data.due === null ? null : yield* instant(data.due)
            const record = yield* client.TrackOwed(
              TrackOwedRequest.make({
                threadId: acting.threadId,
                what: data.what,
                from: data.from,
                since,
                due,
                nextStep: data.nextStep,
              }),
            )
            return { output: view(record) }
          }),
          { signal, tool: 'track_owed' },
        )
      },
    }),
    defineTool({
      name: Tool.update_owed,
      description:
        'Update the deadline, what is blocking it, and the next step for an open commitment, by exact what and from names. Use null for no deadline or no known blocker. Never invent a date or party. An ambiguous name returns the open list for clarification.',
      input: v.strictObject({
        summary,
        what,
        from,
        due: v.nullable(localTime),
        blockedOn: v.nullable(text('What this is blocked on, when known.', 240)),
        nextStep,
      }),
      /** Name resolution and mutation use the same attributed client and server scope. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const selected = yield* select(data)
            const due = data.due === null ? null : yield* instant(data.due)
            const record = yield* client.UpdateOwed(
              UpdateOwedRequest.make({
                id: selected.id,
                due,
                blockedOn: data.blockedOn,
                nextStep: data.nextStep,
              }),
            )
            return { output: view(record) }
          }),
          { signal, tool: 'update_owed' },
        )
      },
    }),
    defineTool({
      name: Tool.resolve_owed,
      description:
        'Resolve what the Person was waiting on when it arrives, by exact what and from names. Say how it resolved from observed evidence. An ambiguous name returns the open list for clarification.',
      input: v.strictObject({
        summary,
        what,
        from,
        how: text('Evidence of what arrived or how it resolved.', 240),
      }),
      /** Closure evidence is supplied in words, while the server supplies its timestamp. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const selected = yield* select(data)
            const record = yield* client.ResolveOwed(
              ResolveOwedRequest.make({ id: selected.id, how: data.how }),
            )
            return { output: view(record) }
          }),
          { signal, tool: 'resolve_owed' },
        )
      },
    }),
    defineTool({
      name: Tool.drop_owed,
      description:
        'Drop an open commitment when the Person no longer cares about it, by exact what and from names, keeping their reason. An ambiguous name returns the open list for clarification.',
      input: v.strictObject({
        summary,
        what,
        from,
        why: text('Why the Person stopped caring about this commitment.', 240),
      }),
      /** Dropping retains the record; it does not delete the Person's history. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const selected = yield* select(data)
            const record = yield* client.DropOwed(
              DropOwedRequest.make({ id: selected.id, why: data.why }),
            )
            return { output: view(record) }
          }),
          { signal, tool: 'drop_owed' },
        )
      },
    }),
  ] as const
}

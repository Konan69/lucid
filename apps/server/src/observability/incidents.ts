import type { Incident } from '@vivid/contracts'
import { Context, Effect, Layer, Schema } from 'effect'

/**
 * Says one `Incident`: the one way the server says that a Person's work did not happen.
 *
 * It is a service and not a function because it owns the error tracker's client, which exists
 * only when `SENTRY_DSN` is set (`issues.ts` `issuesLayer`), and because a test observes what was
 * said through it rather than through the tracker.
 *
 * `record` cannot fail and returns nothing, so a producer calls it beside the outcome it decided
 * (the Run's terminal write, the push receipt, the Computer's start result) without changing
 * that outcome. It is called once per outcome, where the outcome is decided and only when the
 * write that decides it changed something, so a replay or a second observer does not say it twice
 * (`threads/delivery.ts` already guards `recordRunFailure` this way).
 *
 * What the implementation must do, in this order, all from the one `Incident` value:
 *
 * 1. The span. Annotate the current span with the attributes below and set its status to error.
 *    It is untraced itself (`Effect.fnUntraced`), as `refusal.ts` `recordRefusal` is, so the
 *    producer's span is the one that carries them.
 * 2. The log line. One `Effect.logError` with a fixed message from `messages.ts` (`Message.incident`,
 *    to be added: "Person's work did not happen") annotated with the same attributes, so the line
 *    leaves the process (`export.ts` keeps a body only when it is a fixed message).
 * 3. The issue. One event in the error tracker at level `error` (`impactSignal.Incident` in
 *    `@vivid/contracts`), through the client `issuesLayer` initialises and not through
 *    `ErrorReporter` (an Incident is an outcome, not an exception), with:
 *    - `fingerprint`: the case's tag, then `<service>.<tag>` of every hop of the cause. One group
 *      per path of failure, so a cell `SchemaError` under a send is a different issue from a cell
 *      `PiRejected` under a send, which a fingerprint of only the first hop would merge.
 *    - `tags`: every attribute below, so someone holding only the tracker can filter by case,
 *      by service, by tag and by the affected ids.
 *    - `contexts.trace`: `trace_id` and `span_id` of the current Effect span, read from the fiber
 *      as `issues.ts` `reporterLayer` reads them, so the issue opens the trace.
 *    - the event's message: the case's tag, a code name; no exception and no stack, since none
 *      exists and the case says what happened.
 *    The event goes through the same `beforeSend` scrub as every other, which must keep
 *    `fingerprint` and the `vivid.incident.*` tags it now drops.
 *
 * The attributes, derived from `Incident`'s schema and never listed by hand (the way
 * `refusal.ts` derives `refusalExport` from `Refusal.cases`):
 *
 * - `vivid.incident.kind`: the case's tag, one of `Struct.keys(Incident.cases)`.
 * - `vivid.incident.<field>` for each field of each case other than `cause`. A field whose schema
 *   is a closed set of literals (`reason`, `delivery`, `step`) is admitted when its value is a
 *   member (`refusal.ts` `membersOf`). A field that is a branded id is admitted by the shape its
 *   generator guarantees, the way `export.ts` admits `vivid.connection.id` only as a version 4
 *   UUID; an id with no guaranteed shape stays on the stdout line.
 * - `vivid.incident.cause.<n>.service`, `.operation`, `.tag`, `.status` for hop `n` from 0, and
 *   `.issues` as `<path joined by .>:<kind>` items joined by `,`. `service` is admitted as a
 *   member of `IncidentSource`, `operation` and `tag` by `CodeName`, `status` as an integer from
 *   100 to 599, `issues` when every item is built of code names, indices and `IssueKind`
 *   members. `n` runs below `DEEPEST_CAUSE`, so the set of keys is finite and known.
 *
 * So `export.ts` gains one spread, `...incidentExport.map(...)`, beside `refusalExport`, and a case
 * or a field added to `Incident` is exported without a second list to extend.
 */
export interface IncidentsService {
  readonly record: (incident: Incident) => Effect.Effect<void>
}

export class Incidents extends Context.Service<Incidents, IncidentsService>()('vivid/Incidents') {}

/**
 * The contract is written and the recorder is not. A typed defect, not a typed failure: `record`
 * has no error channel, and a caller that reaches it before the recorder exists is a bug that must
 * stop the work, not an outcome it could handle.
 */
class IncidentsNotImplemented extends Schema.TaggedError<IncidentsNotImplemented>()(
  'IncidentsNotImplemented',
  {},
  { title: 'The incident recorder is not written yet' },
) {}

/** The recorder's Layer; its body is the next unit of work, specified on `IncidentsService`. */
export const incidentsLayer = Layer.succeed(
  Incidents,
  Incidents.of({
    record: () => Effect.die(new IncidentsNotImplemented()),
  }),
)

import { Clock, Effect, Option, Predicate, Schema } from 'effect'
import {
  CoverageReason,
  IntegrationResult,
  ObservationTime,
  ResultAsOf,
  ResultContinuation,
  ResultCount,
  ResultCoverage,
  ResultQuery,
  ToolOutcome,
  type ActionEffect,
  type ActionTarget,
  type ServiceId,
} from '@vivid/contracts'

/** Only exact operations from Vivid's Google OpenAPI definitions can establish page semantics. */
const pages = [
  {
    service: 'google/gmail',
    operation: 'gmail.users.messages.list',
    tool: 'gmailApi.gmailUsersMessagesList',
    field: 'messages',
    unit: 'messages',
  },
  {
    service: 'google/gmail',
    operation: 'gmail.users.threads.list',
    tool: 'gmailApi.gmailUsersThreadsList',
    field: 'threads',
    unit: 'threads',
  },
  {
    service: 'google/gmail',
    operation: 'gmail.users.drafts.list',
    tool: 'gmailApi.gmailUsersDraftsList',
    field: 'drafts',
    unit: 'drafts',
  },
  {
    service: 'google/calendar',
    operation: 'calendar.events.list',
    tool: 'calendarApi.calendarEventsList',
    field: 'items',
    unit: 'events',
  },
  {
    service: 'google/calendar',
    operation: 'calendar.events.instances',
    tool: 'calendarApi.calendarEventsInstances',
    field: 'items',
    unit: 'events',
  },
] as const

/** apps beta.22 openapi-names.ts combines the first tag and camel-cased operation id. */
export const canonicalOperation = (service: ServiceId, name: string) => {
  const page = pages.find((entry) => entry.service === service && entry.tool === name)
  return page === undefined ? name : page.operation
}

const decodeInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))
const decodePage = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/** A malformed reviewed page retains Unknown coverage; missing arrays are valid only when absent. */
function pageEvidence(output: Schema.Json, field: string) {
  const decoded = decodePage(output)
  if (Option.isNone(decoded)) return Option.none()
  const values = decoded.value[field]
  const token = decoded.value.nextPageToken
  if (values !== undefined && !Array.isArray(values)) return Option.none()
  if (token !== undefined && (!Predicate.isString(token) || token.length === 0))
    return Option.none()
  return Option.some({ count: values === undefined ? 0 : values.length, token })
}

/** Absence of nextPageToken proves only this list query exhausted, never the whole account. */
function readCoverage(
  service: ServiceId,
  target: typeof ActionTarget.cases.Connection.Type,
  output: Schema.Json,
) {
  const query = ResultQuery.make({
    account: target.account,
    operation: target.tool,
    input: target.input,
    fetched: ResultCount.cases.Unknown.make({}),
    total: ResultCount.cases.Unknown.make({}),
    continuation: ResultContinuation.cases.Unknown.make({}),
  })
  const page = pages.find(
    (entry) =>
      entry.service === service && entry.operation === canonicalOperation(service, target.tool),
  )
  const input = decodeInput(target.input)
  if (page === undefined || Option.isNone(input))
    return ResultCoverage.cases.Unknown.make({ query })
  const parameters =
    input.value.query === undefined ? Option.some({}) : decodeInput(input.value.query)
  // Partial-response masks can hide the continuation; absence then proves no exhaustion.
  if (Option.isNone(parameters) || 'fields' in parameters.value)
    return ResultCoverage.cases.Unknown.make({ query })
  const evidence = pageEvidence(output, page.field)
  if (Option.isNone(evidence)) return ResultCoverage.cases.Unknown.make({ query })
  const { count, token } = evidence.value
  const continuation =
    token === undefined
      ? ResultContinuation.cases.End.make({})
      : ResultContinuation.cases.Next.make({
          input: { ...input.value, query: { ...parameters.value, pageToken: token } },
        })
  const fetched = ResultCount.cases.Known.make({ value: count, unit: page.unit })
  const measured = ResultQuery.make({ ...query, fetched, continuation })
  if (token !== undefined)
    return ResultCoverage.cases.Partial.make({
      query: measured,
      reasons: [CoverageReason.cases.Pagination.make({})],
    })
  return ResultCoverage.cases.Complete.make({ query: measured })
}

/** Refusal before dispatch proves NotRead; server receipt time is never a source timestamp. */
export const notRead = Effect.fn('Connections.notRead')(function* (outcome: ToolOutcome) {
  return IntegrationResult.make({
    outcome,
    coverage: ResultCoverage.cases.NotRead.make({}),
    asOf: ResultAsOf.cases.NotApplicable.make({}),
    observedAt: ObservationTime.make(yield* Clock.currentTimeMillis),
  })
})

/** Dispatched failures preserve uncertainty. Only reviewed successful reads claim measured coverage. */
export const observedResult = Effect.fn('Connections.observedResult')(function* (
  outcome: ToolOutcome,
  call: {
    readonly service: ServiceId
    readonly target: typeof ActionTarget.cases.Connection.Type
    readonly effect: ActionEffect
  },
) {
  const query = ResultQuery.make({
    account: call.target.account,
    operation: call.target.tool,
    input: call.target.input,
    fetched: ResultCount.cases.Unknown.make({}),
    total: ResultCount.cases.Unknown.make({}),
    continuation: ResultContinuation.cases.Unknown.make({}),
  })
  const read = call.effect === 'read'
  const coverage = ToolOutcome.guards.Completed(outcome)
    ? read
      ? readCoverage(call.service, call.target, outcome.output)
      : ResultCoverage.cases.NotApplicable.make({})
    : ResultCoverage.cases.Unknown.make({ query })
  return IntegrationResult.make({
    outcome,
    coverage,
    asOf: read ? ResultAsOf.cases.Unknown.make({}) : ResultAsOf.cases.NotApplicable.make({}),
    observedAt: ObservationTime.make(yield* Clock.currentTimeMillis),
  })
})

import { and, eq, isNull, or } from 'drizzle-orm'
import { FindEventsResponse, InvalidRequest, RoutineTrigger } from '@vivid/contracts'
import { Array as Arr, Effect, Layer, Option, Result, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import {
  IntegrationWatch,
  IntegrationRevoked,
  IntegrationReadFailed,
  IntegrationCursorLost,
  ProviderEvent,
  ProviderEventId,
  Watch,
  WatchBatch,
  WatchCursor,
  type WatchInput,
} from '../routines/watch.ts'
import {
  Executor,
  ExecutorResourceMissing,
  type ExecutorFailure,
  ExecutorCallOutcome,
  ExecutorReferences,
  ExecutorStatus,
  executorLayer,
  type ExecutorTool,
} from './executor.ts'
import { executorFailure } from './errors.ts'
import { decodeRow, listRecords, type ConnectionRecord } from './records.ts'
import { namedAccounts } from './names.ts'
import { connections } from './tables.ts'

/** Output paths describe a provider list; only metadata-classified reads may ever be selected.
 * Snapshots must have stable newest/oldest ordering. A lost high-water id re-baselines from now and records a Thread gap notice.
 */
const PollFilter = Schema.Struct({
  input: Schema.Json,
  itemsPath: Schema.Array(Schema.NonEmptyString),
  idPath: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  newestFirst: Schema.Boolean,
  intervalMinutes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
const decodeFilter = Schema.decodeUnknownEffect(PollFilter)
const decodeObject = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeArray = Schema.decodeUnknownEffect(Schema.Array(Schema.Json))
const decodeId = Schema.decodeUnknownEffect(Schema.Union([Schema.NonEmptyString, Schema.Int]))
const ToolEnvelope = Schema.Struct({ anyOf: Schema.Array(Schema.Json) })
const ToolBranch = Schema.Struct({
  properties: Schema.Struct({
    accountId: Schema.Struct({ const: Schema.String }),
    input: Schema.Json,
  }),
})
const decodeEnvelope = Schema.decodeUnknownOption(ToolEnvelope)
const decodeBranch = Schema.decodeUnknownResult(ToolBranch)

/** Account-operation wrappers are selected privately; their account constants never enter discovery. */
function providerInput(tool: typeof ExecutorTool.Type, references: ExecutorReferences) {
  const envelope = decodeEnvelope(tool.input)
  if (Option.isNone(envelope)) return Option.some({ schema: tool.input, wrap: false })
  if (!ExecutorReferences.guards.Authorized(references)) return Option.none()
  const branch = Arr.findFirst(
    Arr.filterMap(envelope.value.anyOf, (value) => decodeBranch(value)),
    (value) => value.properties.accountId.const === references.account,
  )
  return Option.map(branch, (value) => ({ schema: value.properties.input, wrap: true }))
}

/** Traversal fails at the precise configured shape; missing collections are never invented as []. */
const atPath = Effect.fn('IntegrationWatch.atPath')(function* (
  value: Schema.Json,
  path: readonly string[],
  connectionId: Watch['connectionId'],
) {
  let current = value
  for (const key of path) {
    const object = decodeObject(current)
    if (Option.isNone(object) || !Object.hasOwn(object.value, key))
      return yield* new IntegrationReadFailed({ connectionId })
    const selected = object.value[key]
    if (selected === undefined) return yield* new IntegrationReadFailed({ connectionId })
    current = selected
  }
  return current
})

/** Decode a list and its provider identities once; preserve each item's content without rewriting it. */
const snapshot = Effect.fn('IntegrationWatch.snapshot')(function* (
  value: Schema.Json,
  filter: typeof PollFilter.Type,
  connectionId: Watch['connectionId'],
) {
  const items = yield* decodeArray(yield* atPath(value, filter.itemsPath, connectionId)).pipe(
    Effect.mapError(() => new IntegrationReadFailed({ connectionId })),
  )
  const events = yield* Effect.forEach(
    items,
    Effect.fn('IntegrationWatch.item')(function* (content) {
      const id = yield* decodeId(yield* atPath(content, filter.idPath, connectionId)).pipe(
        Effect.mapError(() => new IntegrationReadFailed({ connectionId })),
      )
      return ProviderEvent.make({ id: ProviderEventId.make(String(id)), content })
    }),
  )
  const ordered = filter.newestFirst ? events : Arr.reverse(events)
  if (new Set(ordered.map((event) => event.id)).size !== ordered.length)
    return yield* new IntegrationReadFailed({ connectionId })
  return ordered
})

/** Establish the high-water identity from a proven snapshot, including a genuinely empty inbox. */
function cursorOf(items: readonly ProviderEvent[]) {
  const first = items[0]
  return first === undefined
    ? WatchCursor.cases.Empty.make({})
    : WatchCursor.cases.Window.make({ ids: [first.id, ...items.slice(1).map((item) => item.id)] })
}

/** A bounded list cannot prove what happened across a gap. Reject both a vanished head and new
 * identities below it; re-baselining reports the loss instead of silently skipping or replaying.
 * Older Item cursors gain full-window checking after their next successful observation. */
const newBatch = Effect.fn('IntegrationWatch.newBatch')(function* (
  watch: Watch,
  items: readonly ProviderEvent[],
) {
  const cursor = cursorOf(items)
  const boundary = WatchCursor.match(watch.cursor, {
    Empty: () => items.length,
    Item: ({ id }) => items.findIndex((item) => item.id === id),
    Window: ({ ids }) => items.findIndex((item) => item.id === ids[0]),
  })
  if (boundary < 0)
    return yield* new IntegrationCursorLost({
      connectionId: watch.connectionId,
      cursor,
      reason: 'Window',
    })
  const seen = WatchCursor.match(watch.cursor, {
    Empty: () => new Set<ProviderEventId>(),
    Item: ({ id }) => new Set([id]),
    Window: ({ ids }) => new Set(ids),
  })
  if (
    WatchCursor.guards.Window(watch.cursor) &&
    items.slice(boundary + 1).some((item) => !seen.has(item.id))
  )
    return yield* new IntegrationCursorLost({
      connectionId: watch.connectionId,
      cursor,
      reason: 'Ordering',
    })
  return WatchBatch.make({
    items: Arr.reverse(items.slice(0, boundary).filter((item) => !seen.has(item.id))),
    cursor: items.length === 0 ? watch.cursor : cursor,
  })
})

/** A vanished provider binding is permanent; network, Executor and provider refusals remain retryable reads. */
const observationFailure = (connectionId: Watch['connectionId']) => (error: ExecutorFailure) =>
  error instanceof ExecutorResourceMissing
    ? new IntegrationRevoked({ connectionId })
    : new IntegrationReadFailed({ connectionId })

/** One read-only call per observation, with current metadata and authorization rechecked each time. */
const read = (executor: Executor['Service']) =>
  Effect.fn('IntegrationWatch.read')(function* (
    row: ConnectionRecord,
    trigger: typeof RoutineTrigger.cases.Integration.Type,
  ) {
    const connectionId = Watch.fields.connectionId.make(row.id)
    if (row.status === 'failed') return yield* new IntegrationReadFailed({ connectionId })
    if (row.status !== 'ready') return yield* new IntegrationRevoked({ connectionId })
    const status = yield* executor
      .status(row.references)
      .pipe(Effect.mapError(observationFailure(connectionId)))
    yield* ExecutorStatus.match<Effect.Effect<void, import('../routines/watch.ts').WatchFailure>>(
      status,
      {
        Ready: () => Effect.void,
        NeedsAuthorization: () => Effect.fail(new IntegrationRevoked({ connectionId })),
        Failed: () => Effect.fail(new IntegrationReadFailed({ connectionId })),
      },
    )
    const tools = yield* executor
      .tools(row.references)
      .pipe(Effect.mapError(observationFailure(connectionId)))
    const tool = tools.find((item) => item.name === trigger.event && item.effect === 'read')
    if (tool === undefined) return yield* new IntegrationReadFailed({ connectionId })
    const input = providerInput(tool, row.references)
    if (Option.isNone(input)) return yield* new IntegrationReadFailed({ connectionId })
    const filter = yield* decodeFilter(trigger.filter).pipe(
      Effect.mapError(() => new IntegrationReadFailed({ connectionId })),
    )
    let provider = filter.input
    if (input.value.wrap) {
      if (!ExecutorReferences.guards.Authorized(row.references))
        return yield* new IntegrationRevoked({ connectionId })
      provider = { accountId: row.references.account, input: filter.input }
    }
    const outcome = yield* executor
      .call({ references: row.references, tool: tool.name, input: provider })
      .pipe(Effect.mapError(observationFailure(connectionId)))
    const value = yield* ExecutorCallOutcome.match<
      Effect.Effect<Schema.Json, import('../routines/watch.ts').WatchFailure>
    >(outcome, {
      Completed: ({ value: content }) => Effect.succeed(content),
      NotReady: () => Effect.fail(new IntegrationRevoked({ connectionId })),
      Rejected: () => Effect.fail(new IntegrationReadFailed({ connectionId })),
      OutcomeUnknown: () => Effect.fail(new IntegrationReadFailed({ connectionId })),
    })
    return yield* snapshot(value, filter, connectionId)
  })

/** Resolve precisely the label inventory assigned to this Person, before filtering readiness. */
const accountOf = Effect.fn('IntegrationWatch.accountOf')(function* (
  actor: Actor,
  account: string,
) {
  const found = namedAccounts(yield* listRecords(actor)).find(
    (item) => item.account.toLowerCase() === account.trim().toLowerCase(),
  )
  if (found === undefined)
    return yield* new InvalidRequest({ message: 'Integration account not found.' })
  return found
})

/** A provider read operation is named once, in words that creation can resolve exactly. */
function eventDescription(tool: typeof ExecutorTool.Type) {
  return `New items returned by ${tool.name}: ${tool.description}. Polling every five minutes by default; select an ordered list and its stable item id.`
}

/** Discovery exposes the provider input schema after removing the private account selector. */
function eventDefinition(tool: typeof ExecutorTool.Type, references: ExecutorReferences) {
  if (tool.effect !== 'read') return Result.failVoid
  return Option.match(providerInput(tool, references), {
    onNone: () => Result.failVoid,
    onSome: ({ schema }) =>
      Result.succeed({
        event: tool.name,
        description: eventDescription(tool),
        filter: {
          type: 'object',
          properties: {
            input: schema,
            itemsPath: {
              type: 'array',
              items: { type: 'string' },
              description: 'Path to the ordered provider list; [] means the response itself.',
            },
            idPath: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              description: 'Path to a stable provider id inside each item.',
            },
            newestFirst: { type: 'boolean' },
            intervalMinutes: { type: 'integer', minimum: 1, default: 5 },
          },
          required: ['input', 'itemsPath', 'idPath', 'newestFirst'],
        },
      }),
  })
}

/** Polling authority owns external reads only; Routine receipts/cursors are owned by the scheduler store. */
export const integrationPollingServiceLayer = Layer.effect(
  IntegrationWatch,
  Effect.gen(function* () {
    const database = yield* Database
    const executor = yield* Executor
    const observe = read(executor)
    /**
     * Binds a trigger to one account: checks the filter and the event against what the account
     * offers now, reads what is already there so only later items count as new, and answers with
     * the watch. The trigger it keeps names the account as it is called now.
     */
    const bind = Effect.fn('IntegrationWatch.bind')(function* (
      { row, account }: ReturnType<typeof namedAccounts>[number],
      trigger: typeof RoutineTrigger.cases.Integration.Type,
    ) {
      const filter = yield* decodeFilter(trigger.filter).pipe(
        Effect.mapError(
          () =>
            new InvalidRequest({
              message: 'Use the event filter schema returned by find_events.',
            }),
        ),
      )
      const tools = yield* executor.tools(row.references).pipe(Effect.mapError(executorFailure))
      const tool = tools.find(
        (item) =>
          item.effect === 'read' &&
          (item.name === trigger.event || eventDescription(item) === trigger.event),
      )
      if (tool === undefined)
        return yield* new InvalidRequest({
          message: 'Select a read-only event returned by find_events.',
        })
      const selected = RoutineTrigger.cases.Integration.make({
        account,
        event: tool.name,
        filter: trigger.filter,
      })
      const items = yield* observe(row, selected)
      return Watch.make({
        connectionId: row.id,
        trigger: selected,
        cursor: cursorOf(items),
        intervalMillis:
          (filter.intervalMinutes === undefined ? 5 : filter.intervalMinutes) * 60_000,
      })
    })
    return IntegrationWatch.of({
      /** Every event name is an actual provider read operation; discovery does not claim native events. */
      discover: Effect.fn('IntegrationWatch.discover')(function* (actor, account) {
        const { row } = yield* accountOf(actor, account).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Executor, executor),
        )
        if (row.status !== 'ready')
          return yield* new InvalidRequest({
            message: 'Reconnect this Integration before watching it.',
          })
        const tools = yield* executor.tools(row.references).pipe(Effect.mapError(executorFailure))
        const events = Arr.filterMap(tools, (tool) => eventDefinition(tool, row.references))
        return FindEventsResponse.make({ events })
      }),
      /** Baseline excludes existing provider records; a new Routine reacts only to subsequent items. */
      prepare: Effect.fn('IntegrationWatch.prepare')(function* (actor, trigger) {
        const found = yield* accountOf(actor, trigger.account).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Executor, executor),
        )
        return yield* bind(found, trigger)
      }),
      /** The same baseline for a watch that exists, found by the Connection it is bound to. */
      rebase: Effect.fn('IntegrationWatch.rebase')(function* (actor, watch) {
        const found = namedAccounts(
          yield* listRecords(actor).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(Executor, executor),
          ),
        ).find((item) => item.row.id === watch.connectionId)
        if (found === undefined)
          return yield* new InvalidRequest({ message: 'Integration account not found.' })
        return yield* bind(found, watch.trigger)
      }),
      /** Binding authorization follows the stored Connection, never a later reused/renamed label. */
      newItems: Effect.fn('IntegrationWatch.newItems')(function* (input: WatchInput) {
        const { watch } = input
        const rows = yield* database.run(
          database
            .select()
            .from(connections)
            .where(
              and(
                eq(connections.id, watch.connectionId),
                or(
                  and(eq(connections.personId, input.personId), isNull(connections.companyId)),
                  input.companyId === null ? undefined : eq(connections.companyId, input.companyId),
                ),
              ),
            ),
        )
        const raw = rows[0]
        if (raw === undefined)
          return yield* new IntegrationRevoked({ connectionId: watch.connectionId })
        const row = yield* decodeRow(raw).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Executor, executor),
          Effect.catchTags({
            Conflict: () =>
              Effect.fail(new IntegrationReadFailed({ connectionId: watch.connectionId })),
            InvalidRequest: () =>
              Effect.fail(new IntegrationReadFailed({ connectionId: watch.connectionId })),
            ServiceUnavailable: () =>
              Effect.fail(new IntegrationReadFailed({ connectionId: watch.connectionId })),
          }),
        )
        const items = yield* observe(row, watch.trigger)
        return yield* newBatch(watch, items)
      }),
    })
  }),
)

/** Existing Executor HTTP authority is reused; tests replace the complete IntegrationWatch Layer. */
export const integrationPollingLayer = integrationPollingServiceLayer.pipe(
  Layer.provide(executorLayer.pipe(Layer.provide(FetchHttpClient.layer))),
)

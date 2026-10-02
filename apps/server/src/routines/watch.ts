import {
  CompanyId,
  ConnectionId,
  FindEventsResponse,
  PersonId,
  RoutineId,
  RoutineTrigger,
  type Conflict,
  type InvalidRequest,
  type ServiceUnavailable,
} from '@vivid/contracts'
import { Context, Schema, Effect, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/** A provider's record identity deduplicates events without becoming Vivid authority. */
export const ProviderEventId = Schema.NonEmptyString.pipe(Schema.brand('ProviderEventId'))
export type ProviderEventId = typeof ProviderEventId.Type
export const ProviderEvent = Schema.Struct({ id: ProviderEventId, content: Schema.Json })
export type ProviderEvent = typeof ProviderEvent.Type
/** Empty is a proven empty baseline; Window holds the full newest-first id set. Item is the older persisted format. */
export const WatchCursor = Schema.TaggedUnion({
  Empty: {},
  /** Read old persisted cursors until their first successful observation upgrades them. */
  Item: { id: ProviderEventId },
  /** The full previous observation makes additions below the high-water id detectable. */
  Window: { ids: Schema.NonEmptyArray(ProviderEventId) },
})
export type WatchCursor = typeof WatchCursor.Type
/** The private binding persists beside the public name and provider configuration. */
export const Watch = Schema.Struct({
  connectionId: ConnectionId,
  trigger: RoutineTrigger.cases.Integration,
  cursor: WatchCursor,
  /** Absence means no consecutive read failures, including rows written before retries existed. */
  failures: Schema.OptionFromOptionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  intervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000)),
})
export type Watch = typeof Watch.Type
export const WatchBatch = Schema.Struct({ items: Schema.Array(ProviderEvent), cursor: WatchCursor })
export type WatchBatch = typeof WatchBatch.Type
export const WatchInput = Schema.Struct({
  routineId: RoutineId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  watch: Watch,
})
export type WatchInput = typeof WatchInput.Type

/** Authorization loss is distinct from provider failure and a truncated observation window. */
export class IntegrationRevoked extends Schema.TaggedError<IntegrationRevoked>()(
  'IntegrationRevoked',
  { connectionId: ConnectionId },
  { title: 'Integration authorization lost' },
) {}
export class IntegrationReadFailed extends Schema.TaggedError<IntegrationReadFailed>()(
  'IntegrationReadFailed',
  { connectionId: ConnectionId },
  { title: 'Integration could not be read' },
) {}
export class IntegrationCursorLost extends Schema.TaggedError<IntegrationCursorLost>()(
  'IntegrationCursorLost',
  {
    connectionId: ConnectionId,
    cursor: WatchCursor,
    reason: Schema.Literals(['Window', 'Ordering']),
  },
  { title: 'Integration observation window exceeded' },
) {}
export type WatchFailure = IntegrationRevoked | IntegrationReadFailed | IntegrationCursorLost
export type WatchError = WatchFailure | DatabaseInfrastructureError

/** Delivery Layer authority: return oldest-first new provider items since this Routine's cursor.
 * A native Layer can implement the same batch boundary; receipts/admission never know the transport.
 */
export interface IntegrationWatchService {
  readonly discover: (
    actor: Actor,
    account: string,
  ) => Effect.Effect<
    typeof FindEventsResponse.Type,
    Conflict | InvalidRequest | ServiceUnavailable | DatabaseInfrastructureError
  >
  readonly prepare: (
    actor: Actor,
    trigger: typeof RoutineTrigger.cases.Integration.Type,
  ) => Effect.Effect<Watch, Conflict | InvalidRequest | ServiceUnavailable | WatchError>
  readonly newItems: (input: WatchInput) => Effect.Effect<WatchBatch, WatchError>
}
export class IntegrationWatch extends Context.Service<IntegrationWatch, IntegrationWatchService>()(
  'vivid/IntegrationWatch',
) {}

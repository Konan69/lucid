import { Schema } from 'effect'
import { ComputerLifecycle, Device } from './computers.js'
import { AccountOrigin, ConnectionState } from './connections.js'
import { ToolName } from './tools.js'

/** A failed fact lookup is unknown, never an empty successful inventory. */
export const CapabilityFactFailure = Schema.TaggedUnion({
  ComputerLookup: {},
  DeviceLookup: {},
  IntegrationLookup: {},
  RuntimeUnavailable: {},
})
/** A lookup failure and a successful empty inventory carry different claims. */
const fact = <S extends Schema.Constraint>(value: S) =>
  Schema.TaggedUnion({
    Available: { value },
    Unavailable: { cause: CapabilityFactFailure },
  })
export const CapabilityComputerFact = fact(
  Schema.Struct({ state: ComputerLifecycle, heldByPerson: Schema.Boolean }),
)
export const CapabilityDeviceFact = fact(Schema.Array(Device))
export const CapabilityIntegrationFact = fact(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({ account: Schema.String, state: ConnectionState, origin: AccountOrigin }),
    ),
    setup: Schema.Literals(['Available', 'Unavailable', 'Unknown']),
  }),
)
/** Authenticated, viewer-free observations scoped to the acting Person and workspace. */
export const CapabilityFacts = Schema.Struct({
  observedAt: Schema.NullOr(Schema.Finite),
  computer: CapabilityComputerFact,
  devices: CapabilityDeviceFact,
  integrations: CapabilityIntegrationFact,
})
export type CapabilityFacts = typeof CapabilityFacts.Type

/** Support and present readiness differ. WakeOnUse deliberately keeps tools mounted. */
export const CapabilityAvailability = Schema.TaggedUnion({
  Available: {},
  WakeOnUse: {},
  NeedsConnection: {},
  NeedsPermission: {},
  TemporarilyUnavailable: { reason: Schema.String },
  Unknown: {},
  Unsupported: { reason: Schema.String },
})
export type CapabilityAvailability = typeof CapabilityAvailability.Type
/** The runtime projects its actual registrations together with server facts and local Memory. */
export const CapabilityReading = Schema.Struct({
  facts: CapabilityFacts,
  abilities: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      tools: Schema.Array(ToolName),
      availability: CapabilityAvailability,
    }),
  ),
})
export type CapabilityReading = typeof CapabilityReading.Type

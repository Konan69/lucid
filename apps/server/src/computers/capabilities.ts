import { Clock, Effect } from 'effect'
import {
  CapabilityComputerFact,
  CapabilityDeviceFact,
  CapabilityFactFailure,
  CapabilityFacts,
  CapabilityIntegrationFact,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { ConnectionStore } from '../connections/store.ts'
import { ComputerStore } from './store.ts'
import { DeviceRegistry } from './device.ts'

/** Each source retains its own failure. No viewer, deep probe, wake or activity write is needed. */
export const getCapabilities = Effect.fn('Capabilities.read')(function* (actor: Actor) {
  const computer = yield* ComputerStore
  const devices = yield* DeviceRegistry
  const integrations = yield* ConnectionStore
  return CapabilityFacts.make(
    yield* Effect.all(
      {
        observedAt: Clock.currentTimeMillis,
        computer: computer.inspect(actor.person.id).pipe(
          Effect.map((value) => CapabilityComputerFact.cases.Available.make({ value })),
          Effect.orElseSucceed(() =>
            CapabilityComputerFact.cases.Unavailable.make({
              cause: CapabilityFactFailure.cases.ComputerLookup.make({}),
            }),
          ),
        ),
        devices: devices.list(actor.person.id).pipe(
          Effect.map((value) => CapabilityDeviceFact.cases.Available.make({ value })),
          Effect.orElseSucceed(() =>
            CapabilityDeviceFact.cases.Unavailable.make({
              cause: CapabilityFactFailure.cases.DeviceLookup.make({}),
            }),
          ),
        ),
        integrations: integrations.list(actor).pipe(
          Effect.map((value) =>
            CapabilityIntegrationFact.cases.Available.make({
              value: {
                accounts: value.connections.map((connection) => ({
                  account: connection.account,
                  state: connection.state,
                })),
                // Setup is provider-specific and discovery remains authoritative. Listing accounts does
                // not attest operator OAuth configuration for a different, unconnected service.
                setup: 'Unknown',
              },
            }),
          ),
          Effect.orElseSucceed(() =>
            CapabilityIntegrationFact.cases.Unavailable.make({
              cause: CapabilityFactFailure.cases.IntegrationLookup.make({}),
            }),
          ),
        ),
      },
      { concurrency: 3 },
    ),
  )
})

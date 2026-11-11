import { describe, expect, it } from '@effect/vitest'
import {
  AddIntegrationOutcome,
  ConnectionGrant,
  ConnectionMatch,
  ConnectionState,
  FindIntegrationsResponse,
} from '@vivid/contracts'
import { added, integrations } from './connectionviews.ts'

// The server proves persistence; these are the failure details the model receives from its tools.
describe('Integration failure views', () => {
  it('carries the stored failure reason without sending the Person to settings', () => {
    const failed = AddIntegrationOutcome.cases.Failed.make({
      account: 'OpenSignIn',
      name: 'OpenSignIn',
      reason: 'Provider resource missing',
    })
    expect(added(failed)).toMatchObject({ reason: 'Provider resource missing' })
    expect(JSON.stringify(added(failed))).not.toContain('settings')
    const found = FindIntegrationsResponse.make({
      catalog: 'available',
      omittedAccounts: 0,
      integrations: [
        ConnectionMatch.cases.Account.make({
          name: 'OpenSignIn',
          account: 'OpenSignIn',
          identity: null,
          connected: false,
          shared: true,
          state: ConnectionState.cases.Failed.make({ reason: 'Provider resource missing' }),
          grant: ConnectionGrant.cases.Unverified.make({}),
          origin: 'Service',
        }),
      ],
    })
    expect(integrations(found).integrations).toContainEqual(
      expect.objectContaining({
        account: 'OpenSignIn',
        state: 'failed',
        reason: 'Provider resource missing',
      }),
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  AddIntegrationOutcome,
  Connection,
  ConnectionAuthorizationMessage,
  ConnectionId,
  ConnectionMatch,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  PersonId,
  ServiceId,
  ServiceAuthorization,
  TestIntegrationOutcome,
} from '@vivid/contracts'
import { Schema } from 'effect'
import { added, integrations, tested } from './connectionviews.ts'

const connection = Connection.make({
  id: ConnectionId.make('MARK-connection'),
  service: ServiceId.make('MARK-service'),
  serviceName: 'Records',
  mark: null,
  label: 'Work',
  ownership: ConnectionOwnership.cases.Personal.make({
    owner: { id: PersonId.make('MARK-person'), name: 'Ada', image: null },
  }),
  state: ConnectionState.cases.NeedsAuthorization.make({}),
  createdAt: 1,
})
const decodeCard = Schema.decodeUnknownSync(ConnectionAuthorizationMessage)

/** Projections are exercised with recognizable authority and secret markers from upstream records. */
describe('integration model views', () => {
  it('projects discovery and test receipts without identifiers or persisted failure diagnostics', () => {
    const view = integrations({
      catalog: 'available',
      omittedAccounts: 3,
      integrations: [
        ConnectionMatch.cases.Account.make({
          name: 'Records',
          account: 'Work',
          connected: false,
          shared: false,
          state: ConnectionState.cases.Failed.make({ reason: 'KEY-MUST-NOT-APPEAR' }),
        }),
        ConnectionMatch.cases.Catalog.make({
          name: 'Linear',
          description: 'Track issues',
          connected: false,
          authorization: ServiceAuthorization.cases.SignIn.make({}),
        }),
      ],
    })
    expect(view).toMatchObject({
      omittedAccounts: 3,
      integrations: [
        { account: 'Work', state: 'failed' },
        { name: 'Linear', connected: false },
      ],
    })
    expect(JSON.stringify(view)).not.toContain('KEY-MUST-NOT-APPEAR')
    const receipt = tested(
      TestIntegrationOutcome.cases.Tested.make({
        account: 'Work',
        tools: ['health'],
        tool: 'health',
      }),
    )
    expect(receipt).toEqual({
      works: true,
      account: 'Work',
      tools: ['health'],
      testedTool: 'health',
    })
    expect(JSON.stringify({ view, receipt })).not.toContain('MARK-')
  })
  it('directs an existing account to discovery without rewriting its lookup name', () => {
    const view = added(
      AddIntegrationOutcome.cases.AlreadyConnected.make({
        account: 'https://private.example/account',
        name: 'Records',
      }),
    )
    expect(view).toMatchObject({ alreadyConnected: true })
    expect(JSON.stringify(view)).toContain('Records is already connected')
    expect(JSON.stringify(view)).toContain('Call find_tools')
    expect(JSON.stringify(view)).not.toContain('private.example')
    expect(view).not.toHaveProperty('account')
  })
  it('resumes authorization with the existing connection handle', () => {
    const view = added(
      AddIntegrationOutcome.cases.PendingAuthorization.make({
        account: 'Work',
        step: ConnectionStep.cases.OpenSignIn.make({
          connection,
          address: 'https://private.example/sign-in',
        }),
      }),
    )
    expect(view).toMatchObject({
      authorization: { connectionId: connection.id },
      reason:
        'Sign in to finish connecting Records. Call find_tools for the account names you may use.',
    })
    expect(JSON.stringify(view)).not.toContain('https://private.example/sign-in')
  })
  it('names failed and waiting Integrations without account or Person references', () => {
    const failed = added(
      AddIntegrationOutcome.cases.Failed.make({ name: 'Records', account: 'MARK-account' }),
    )
    expect(failed).toEqual({
      added: false,
      message:
        'Records has failed. Remove Records in Integrations settings before connecting again. Call find_tools for the account names you may use.',
    })
    const waiting = added(AddIntegrationOutcome.cases.AwaitingInitiator.make({ name: 'Records' }))
    expect(waiting).toEqual({
      added: false,
      message:
        'Records is a Company Integration waiting for the Person who started it to finish signing in. Call find_tools for the account names you may use.',
    })
    expect(JSON.stringify({ failed, waiting })).not.toContain('MARK-')
  })
  it('keeps the OAuth sign-in address out of the model-visible card', () => {
    const view = decodeCard(
      added(
        AddIntegrationOutcome.cases.NeedsSignIn.make({
          step: ConnectionStep.cases.OpenSignIn.make({
            connection,
            address: 'https://service.example/sign-in',
          }),
        }),
      ),
    )
    expect(view).toMatchObject({
      kind: 'connection-request',
      service: 'MARK-service',
      authorization: {
        connectionId: 'MARK-connection',
      },
    })
    expect(JSON.stringify(view)).not.toContain('MARK-person')
    expect(JSON.stringify(view)).not.toContain('ownership')
    expect(JSON.stringify(view)).not.toContain('https://service.example/sign-in')
    expect(view.authorization).not.toHaveProperty('address')
  })
  it('emits only masked-dialog field definitions and never a key submission', () => {
    const view = decodeCard(
      added(
        AddIntegrationOutcome.cases.NeedsKey.make({
          step: ConnectionStep.cases.EnterKey.make({
            connection,
            fields: [{ name: 'apiKey', label: 'API key' }],
          }),
        }),
      ),
    )
    expect(view).toMatchObject({
      kind: 'connection-request',
      authorization: {
        connectionId: 'MARK-connection',
        fields: [{ name: 'apiKey', label: 'API key' }],
      },
    })
    expect(JSON.stringify(view)).not.toContain('MARK-person')
    expect(JSON.stringify(view)).not.toContain('KEY-MUST-NOT-APPEAR')
  })
})

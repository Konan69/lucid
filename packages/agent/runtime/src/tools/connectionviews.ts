import {
  AddIntegrationOutcome,
  ConnectionAuthorization,
  ConnectionAuthorizationMessage,
  ConnectionMatch,
  ConnectionState,
  TestIntegrationOutcome,
  type FindIntegrationsResponse,
} from '@vivid/contracts'
import type { Schema } from 'effect'
import { approval, modelText } from './views.ts'

/** Projection is explicit: discovery exposes no product or provider references. */
export function integrations(response: FindIntegrationsResponse) {
  return {
    catalog: response.catalog,
    integrations: response.integrations.map((entry) =>
      ConnectionMatch.match<typeof Schema.Json.Type>(entry, {
        Account: ({ name, account, connected, shared, state }) => ({
          name: modelText(name),
          account: modelText(account),
          connected,
          shared,
          state: ConnectionState.match(state, {
            Ready: () => 'ready',
            NeedsAuthorization: () => 'needs sign-in',
            Failed: () => 'failed',
          }),
        }),
        Catalog: ({ name, description, connected }) => ({
          name: modelText(name),
          description: modelText(description),
          connected,
        }),
      }),
    ),
  }
}

/** Authorization references are the existing card exception; ownership and foreign ids stay hidden. */
export function added(outcome: AddIntegrationOutcome) {
  return AddIntegrationOutcome.match<typeof Schema.Json.Type>(outcome, {
    Added: ({ account }) => ({ added: true, account: modelText(account) }),
    NeedsSignIn: ({ step }) =>
      ConnectionAuthorizationMessage.make({
        kind: 'connection-request',
        service: step.connection.service,
        serviceName: modelText(step.connection.serviceName),
        reason: 'Sign in to finish connecting this integration.',
        ready: false,
        authorization: ConnectionAuthorization.cases.OpenSignIn.make({
          connectionId: step.connection.id,
        }),
      }),
    NeedsKey: ({ step }) =>
      ConnectionAuthorizationMessage.make({
        kind: 'connection-request',
        service: step.connection.service,
        serviceName: modelText(step.connection.serviceName),
        reason: 'Enter the key in the secure dialog to finish connecting this integration.',
        ready: false,
        authorization: ConnectionAuthorization.cases.EnterKey.make({
          connectionId: step.connection.id,
          fields: step.fields,
        }),
      }),
    NotAnIntegration: ({ reason }) => ({ added: false, reason }),
    Unreachable: ({ reason }) => ({ added: false, reason }),
  })
}

/** Test receipts omit external output and all references except an approval card's required handle. */
export function tested(outcome: TestIntegrationOutcome) {
  return TestIntegrationOutcome.match<typeof Schema.Json.Type>(outcome, {
    Tested: ({ account, tools, tool }) => ({
      works: true,
      account: modelText(account),
      tools,
      testedTool: tool,
    }),
    NotTested: ({ account, tools, reason }) => ({
      works: false,
      account: modelText(account),
      tools,
      reason,
    }),
    ApprovalRequired: approval,
    Blocked: ({ rule }) => ({ works: false, reason: modelText(rule) }),
    Unreachable: () => ({ works: false, reason: 'The integration could not be reached.' }),
  })
}

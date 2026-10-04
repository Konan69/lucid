import {
  AddIntegrationOutcome,
  ConnectionAuthorization,
  ConnectionAuthorizationMessage,
  ConnectionMatch,
  ConnectionState,
  ConnectionStep,
  ServiceAuthorization,
  TestIntegrationOutcome,
  type FindIntegrationsResponse,
} from '@vivid/contracts'
import type { Schema } from 'effect'
import { approval, modelText } from './views.ts'

/** Discovery preserves setup readiness in plain words, so a catalogue listing cannot imply
 * a working sign-in button. Product and provider references stay out of model context. */
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
        Catalog: ({ name, description, connected, authorization }) => ({
          name: modelText(name),
          description: modelText(description),
          connected,
          authorization: ServiceAuthorization.match(authorization, {
            None: () => 'Ready to connect without sign-in.',
            SignIn: () => 'Ready to sign in.',
            Key: () => 'Ready to connect with a key in the secure dialog.',
            KnownAfterInstall: () =>
              'Ready to connect; the person signs in or enters a key in the secure dialog when they start.',
            SetupRequired: () =>
              `${modelText(name)} is not set up on this Vivid yet; whoever runs it needs to register a sign-in application for it. Do not offer a connect card.`,
          }),
        }),
      }),
    ),
  }
}

/** Authorization references are the existing card exception; ownership and foreign ids stay hidden. */
export function added(outcome: AddIntegrationOutcome): typeof Schema.Json.Type {
  return AddIntegrationOutcome.match<typeof Schema.Json.Type>(outcome, {
    Added: ({ account }) => ({ added: true, account: modelText(account) }),
    AlreadyConnected: () => ({
      alreadyConnected: true,
      message:
        'This integration is already connected. Call find_tools to discover its tools and account name.',
    }),
    Failed: () => ({
      added: false,
      message:
        'This integration has failed. Remove it in Integrations settings before connecting again.',
    }),
    PendingAuthorization: ({ account, step }) =>
      ConnectionStep.match(step, {
        Done: () => added(AddIntegrationOutcome.cases.AlreadyConnected.make({ account })),
        OpenSignIn: (value) => added(AddIntegrationOutcome.cases.NeedsSignIn.make({ step: value })),
        EnterKey: (value) => added(AddIntegrationOutcome.cases.NeedsKey.make({ step: value })),
      }),
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

import {
  AddIntegrationOutcome,
  MakeIntegrationOutcome,
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
    omittedAccounts: response.omittedAccounts,
    integrations: response.integrations.map((entry) =>
      ConnectionMatch.match<Schema.Json>(entry, {
        // `signedInAs` is who the service says the account is. It is said beside the account's
        // name because a Person may have named the account ("Gmail (Work)"), and may then ask for
        // it by either: the name, or the address behind it.
        Account: ({ name, account, identity, connected, shared, state }) => ({
          name: modelText(name),
          account: modelText(account),
          signedInAs: identity === null ? null : modelText(identity),
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
export function added(outcome: AddIntegrationOutcome): Schema.Json {
  return AddIntegrationOutcome.match<Schema.Json>(outcome, {
    Added: ({ account }) => ({ added: true, account: modelText(account) }),
    AlreadyConnected: ({ name }) => ({
      alreadyConnected: true,
      message: `${modelText(name)} is already connected. Call find_tools to discover its tools and the account names you may use.`,
    }),
    Failed: ({ name }) => ({
      added: false,
      message: `${modelText(name)} has failed. Remove ${modelText(name)} in Integrations settings before connecting again. Call find_tools for the account names you may use.`,
    }),
    AwaitingInitiator: ({ name }) => ({
      added: false,
      message: `${modelText(name)} is a Company Integration waiting for the Person who started it to finish signing in. Call find_tools for the account names you may use.`,
    }),
    PendingAuthorization: ({ account, step }) =>
      ConnectionStep.match(step, {
        Done: ({ connection }) =>
          added(
            AddIntegrationOutcome.cases.AlreadyConnected.make({
              account,
              name: connection.serviceName,
            }),
          ),
        OpenSignIn: (value) => added(AddIntegrationOutcome.cases.NeedsSignIn.make({ step: value })),
        EnterKey: (value) => added(AddIntegrationOutcome.cases.NeedsKey.make({ step: value })),
      }),
    NeedsSignIn: ({ step }) =>
      ConnectionAuthorizationMessage.make({
        kind: 'connection-request',
        service: step.connection.service,
        serviceName: modelText(step.connection.serviceName),
        reason: `Sign in to finish connecting ${modelText(step.connection.serviceName)}. Call find_tools for the account names you may use.`,
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
        reason: `Enter the key in the secure dialog to finish connecting ${modelText(step.connection.serviceName)}. Call find_tools for the account names you may use.`,
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
  return TestIntegrationOutcome.match<Schema.Json>(outcome, {
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

/** Made apps use the same secure authorization card as imports; compiler messages expose no ids. */
export function made(outcome: MakeIntegrationOutcome): Schema.Json {
  return MakeIntegrationOutcome.match<Schema.Json>(outcome, {
    Made: ({ account }) => ({
      ok: true,
      account: modelText(account),
      message: `Made. It is ready as ${modelText(account)}.`,
    }),
    PendingAuthorization: (value) =>
      added(AddIntegrationOutcome.cases.PendingAuthorization.make(value)),
    BuildFailed: ({ message }) => ({
      ok: false,
      message: `The build failed: ${modelText(message)}`,
    }),
    // A made Integration's source cannot be replaced in place: say so, so new files are not lost.
    AlreadyConnected: ({ account, name }) => ({
      ok: false,
      account: modelText(account),
      message: `An Integration called ${modelText(name)} already exists and was not changed. To do something different, make a new one under a new name.`,
    }),
    Failed: (value) => added(AddIntegrationOutcome.cases.Failed.make(value)),
  })
}

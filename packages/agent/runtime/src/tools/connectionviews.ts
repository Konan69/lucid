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
import { approval, modelText, plain, quiet, refused, translate } from './views.ts'

/**
 * An account as the Person would say it. Account names are handles the server assigns for tool
 * calls ("Notion (Agency)", "Gmail (ada@example.com)"), and replies that repeated them read like
 * a settings page ("Notion (Agency) still can't load its tools"). The exact name stays beside
 * this, because tools are called by it; this is only how it is said: "your Agency Notion", "your
 * Gmail at ada@example.com", and "your team's" for a Company account.
 */
export function spoken(account: string, shared: boolean) {
  const owner = shared ? 'your team’s' : 'your'
  const open = account.lastIndexOf(' (')
  if (open < 1 || !account.endsWith(')')) return `${owner} ${account}`
  const service = account.slice(0, open)
  const label = account.slice(open + 2, -1)
  return label.includes('@') ? `${owner} ${service} at ${label}` : `${owner} ${label} ${service}`
}

/**
 * What an account's state means for the Person, beside the state Vivid acts on. A ready account
 * has nothing to explain. One that needs signing in, or has failed, is said as what Vivid cannot
 * do and the one thing that fixes it, so "the connection never finished authorizing, so it loads
 * zero tools" (production, 11 November 2026) has a plain sentence to come from. A failed account
 * is replaced by connecting it again (`connect`), so that is the fix it names; the provider's own
 * reason stays in `reason`, for Vivid.
 */
export function accountMeaning(said: string, state: ConnectionState) {
  return ConnectionState.match(state, {
    Ready: () => null,
    NeedsAuthorization: () => `i can’t get into ${said} until you sign in to it again.`,
    Failed: () => `${said} has stopped working for me; it needs connecting again.`,
  })
}

/** Discovery preserves setup readiness in plain words, so a catalogue listing cannot imply
 * a working sign-in button. Product and provider references stay out of model context. Each
 * account carries how to say it (`say_as`) and what its state means for the Person (`tell_them`). */
export function integrations(response: FindIntegrationsResponse) {
  return {
    // `services` says whether the list of services this Vivid can add could be read.
    services: response.catalog,
    omittedAccounts: response.omittedAccounts,
    integrations: response.integrations.map((entry) =>
      ConnectionMatch.match<Schema.Json>(entry, {
        // `signedInAs` is who the service says the account is. It is said beside the account's
        // name because a Person may have named the account ("Gmail (Work)"), and may then ask for
        // it by either: the name, or the address behind it.
        Account: ({ name, account, identity, connected, shared, state, grant, origin }) => ({
          name: modelText(name),
          account: modelText(account),
          // An app Vivid made for its own work is never said as something the Person connected.
          made_by_you: origin === 'Vivid',
          say_as: origin === 'Vivid' ? null : modelText(spoken(account, shared)),
          signedInAs: identity === null ? null : modelText(identity),
          connected,
          grant,
          shared,
          state: ConnectionState.match(state, {
            Ready: () => 'ready',
            NeedsAuthorization: () => 'needs sign-in',
            Failed: () => 'failed',
          }),
          reason: ConnectionState.match(state, {
            Ready: () => null,
            NeedsAuthorization: () => null,
            Failed: ({ reason }) => modelText(reason),
          }),
          tell_them:
            origin === 'Vivid' ? null : accountMeaning(modelText(spoken(account, shared)), state),
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
          // Only a service this Vivid cannot connect has something the Person needs explained:
          // "register a sign-in application" is the operator's job, never theirs to hear.
          tell_them: ServiceAuthorization.guards.SetupRequired(authorization)
            ? `i can’t connect ${modelText(name)} yet. whoever runs your vivid has to switch it on first.`
            : null,
        }),
      }),
    ),
  }
}

/**
 * Authorization references are the existing card exception; ownership and foreign ids stay hidden.
 * A card's `reason` is shown to the Person on the card, so it is written to them and carries no
 * instruction for the model. The Run ends at a card, and the delivery that follows the sign-in
 * tells Vivid to carry on, so there is nothing for the model to be told here.
 */
export function added(outcome: AddIntegrationOutcome): Schema.Json {
  return AddIntegrationOutcome.match<Schema.Json>(outcome, {
    Added: ({ account }) => ({ added: true, account: modelText(account) }),
    AlreadyConnected: ({ name }) => ({
      alreadyConnected: true,
      message: `${modelText(name)} is already connected, so there is nothing for them to do. Call find_tools to discover its tools and the account names you may use.`,
    }),
    Failed: ({ name, reason }) => ({
      ...refused(
        `${name} has failed: ${reason}`,
        plain(`i can’t get into your ${name} anymore; it needs connecting again.`),
      ),
      added: false,
      reason: modelText(reason),
    }),
    AwaitingInitiator: ({ name }) => ({
      ...refused(
        `${name} is a Company Integration waiting for the Person who started it to finish signing in. Call find_tools for the account names you may use.`,
        plain(
          `your team’s ${name} isn’t ready yet: whoever started connecting it still has to finish signing in.`,
        ),
      ),
      added: false,
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
        reason: `Sign in to finish connecting ${modelText(step.connection.serviceName)}.`,
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
        reason: `Enter the key in the secure dialog to finish connecting ${modelText(step.connection.serviceName)}.`,
        ready: false,
        authorization: ConnectionAuthorization.cases.EnterKey.make({
          connectionId: step.connection.id,
          fields: step.fields,
        }),
      }),
    // An address Vivid found itself and that turned out not to be a server is Vivid's to replace;
    // one that could not be reached may stop what the Person asked for.
    NotAnIntegration: ({ reason }) => ({
      ...refused(`That address could not be added: ${reason}.`, quiet),
      added: false,
      reason,
    }),
    Unreachable: ({ reason }) => ({
      ...refused(`That address could not be added: ${reason}.`, translate),
      added: false,
      reason,
    }),
  })
}

/**
 * Test receipts omit external output and all references except an approval card's required handle.
 * A working account is reported as what the Person can now have, not as a test that passed
 * ("Calendar's live — I read it successfully", production, November 2026).
 */
export function tested(outcome: TestIntegrationOutcome) {
  return TestIntegrationOutcome.match<Schema.Json>(outcome, {
    Tested: ({ account, tools, tool }) => ({
      works: true,
      account: modelText(account),
      tools,
      testedTool: tool,
      message:
        'It works. Tell them what they can have from it now, in their words (“your calendar’s in. you’re free after 4 today”), not that a test call succeeded.',
    }),
    NotTested: ({ account, tools, reason }) => ({
      ...refused(`${account} could not be tested: ${reason}.`, translate),
      works: false,
      account: modelText(account),
      tools,
      reason,
    }),
    // One tool refusing a test call says nothing yet about the account: Vivid tries another.
    Refused: ({ account, tools, tool, message }) => ({
      ...refused(
        `${tool} refused the test call: ${message} Try another read-only tool with use_tool before concluding the integration does not work.`,
        quiet,
      ),
      works: false,
      account: modelText(account),
      tools,
      testedTool: tool,
    }),
    ApprovalRequired: approval,
    Blocked: ({ rule }) => ({
      ...refused(
        `A rule forbids the test call: “${rule}”.`,
        plain(`checking it goes against one of your rules (“${rule}”), so i didn’t.`),
      ),
      works: false,
      reason: modelText(rule),
    }),
    Unreachable: () => ({
      ...refused(
        'The integration could not be reached.',
        plain('i couldn’t reach it to check that it works.'),
      ),
      works: false,
    }),
  })
}

/** Made apps use the same secure authorization card as imports; compiler messages expose no ids. */
export function made(outcome: MakeIntegrationOutcome): Schema.Json {
  return MakeIntegrationOutcome.match<Schema.Json>(outcome, {
    // The Person asked for a reminder or a check, never for an Integration, so a made one is
    // reported as what it now does for them ("Made. It is ready as X." was repeated as it was).
    Made: ({ account }) => ({
      ok: true,
      account: modelText(account),
      message: `Made and ready; its account name for tool calls is ${modelText(account)}. To them, say what it now does for them (“i’ll remind you at 9”), never that you made an integration.`,
    }),
    PendingAuthorization: (value) =>
      added(AddIntegrationOutcome.cases.PendingAuthorization.make(value)),
    // A build failure is Vivid's own source to fix; the Person never hears about it.
    BuildFailed: ({ message }) => refused(`The build failed: ${message}`, quiet),
    NotAnIntegration: ({ reason }) => refused(reason, translate),
    Unreachable: ({ reason }) => refused(reason, translate),
    // A made Integration's source cannot be replaced in place: say so, so new files are not lost.
    AlreadyConnected: ({ account, name }) => ({
      ...refused(
        `An Integration called ${name} already exists and was not changed. To do something different, make a new one under a new name.`,
        quiet,
      ),
      account: modelText(account),
    }),
    Failed: ({ name }) => ({
      ...refused(
        `${name} has failed. Call find_integrations to read the failure reason.`,
        translate,
      ),
      added: false,
    }),
  })
}

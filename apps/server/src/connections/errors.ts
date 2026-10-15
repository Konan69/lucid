import { Match } from 'effect'
import {
  Conflict,
  InvalidRequest,
  ServiceUnavailable,
  openApiUnsupportedMessage,
  mcpQueryUnsupportedMessage,
} from '@vivid/contracts'
import { connectionSetupMessage, resourceReason, type ExecutorFailure } from './executor.ts'

/** Provider internals never cross RPC; unavailable authority remains distinct from bad user input. */
export const executorFailure = Match.type<ExecutorFailure>().pipe(
  Match.tagsExhaustive({
    ExecutorImportQueryUnsupported: () =>
      new InvalidRequest({ message: mcpQueryUnsupportedMessage }),
    ExecutorSourceUnsupported: () => new InvalidRequest({ message: openApiUnsupportedMessage }),
    ExecutorPublicAddressRequired: () =>
      new ServiceUnavailable({
        service: 'connections',
        message: 'Public integration address enforcement is not configured.',
      }),
    ServiceUnavailable: (error) => error,
    ExecutorOAuthSetupFailed: () =>
      new InvalidRequest({
        message: 'This Integration could not prepare sign-in. Review its OAuth configuration.',
      }),
    ExecutorRequirementChanged: () =>
      new Conflict({ message: 'Integration account setup changed. Reconnect it.' }),
    ExecutorConnectionRefused: () =>
      new InvalidRequest({ message: 'Integration access does not allow connecting this account.' }),
    ExecutorAccountChoiceUnsupported: () =>
      new InvalidRequest({
        message: 'This integration requires account selection Vivid does not support.',
      }),
    ExecutorOAuthClientUnavailable: () =>
      new InvalidRequest({ message: 'The sign-in client is unavailable. Review its setup.' }),
    ExecutorOAuthClientAmbiguous: () =>
      new InvalidRequest({ message: 'Select one sign-in client in the integration setup.' }),
    ExecutorSetupRequired: () => new InvalidRequest({ message: connectionSetupMessage }),
    ExecutorInputInvalid: () =>
      new InvalidRequest({ message: 'Tool input did not match its schema.' }),
    ExecutorRejected: ({ message }) => new InvalidRequest({ message }),
    ExecutorAppNameTaken: () =>
      new Conflict({ message: 'The Integration installation changed; retry connecting.' }),
    ExecutorConflict: () =>
      new Conflict({ message: 'The integration changed; reload before continuing.' }),
    ExecutorSignInRequired: ({ message }) => new InvalidRequest({ message }),
    ExecutorNotReady: () =>
      new InvalidRequest({ message: 'Authorize this integration before continuing.' }),
    ExecutorAccessDenied: () =>
      new ServiceUnavailable({
        service: 'connections',
        message: 'Integration authority is unavailable.',
      }),
    ExecutorResourceMissing: ({ resource }) =>
      new InvalidRequest({ message: resourceReason(resource) }),
    ExecutorAuthorizationUnavailable: unavailable,
    ExecutorApprovalUnsupported: () =>
      new InvalidRequest({
        message: 'This Integration action needs an approval Vivid cannot give yet.',
      }),
    ExecutorTransportFailure: unavailable,
    ExecutorResponseInvalid: unavailable,
    ExecutorExecutionUncertain: unavailable,
  }),
)

/** Transport and protocol failures carry no provider payload or credential in the public error. */
function unavailable() {
  return new ServiceUnavailable({
    service: 'connections',
    message: 'Integrations are unavailable.',
  })
}

import { Match } from 'effect'
import { Conflict, InvalidRequest, ServiceUnavailable } from '@vivid/contracts'
import { connectionSetupMessage, resourceReason, type ExecutorFailure } from './executor.ts'

/** Provider internals never cross RPC; unavailable authority remains distinct from bad user input. */
export const executorFailure = Match.type<ExecutorFailure>().pipe(
  Match.tagsExhaustive({
    ExecutorPublicAddressRequired: () =>
      new ServiceUnavailable({
        service: 'connections',
        message: 'Public integration address enforcement is not configured.',
      }),
    ServiceUnavailable: (error) => error,
    ExecutorSetupRequired: () => new InvalidRequest({ message: connectionSetupMessage }),
    ExecutorRejected: ({ message }) => new InvalidRequest({ message }),
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

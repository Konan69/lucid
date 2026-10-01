import { Match } from 'effect'
import { Conflict, InvalidRequest, ServiceUnavailable } from '@vivid/contracts'
import { resourceReason, type ExecutorFailure } from './executor.ts'

/** Provider internals never cross RPC; unavailable authority remains distinct from bad user input. */
export const executorFailure = Match.type<ExecutorFailure>().pipe(
  Match.tagsExhaustive({
    ServiceUnavailable: (error) => error,
    ExecutorRejected: ({ message }) => new InvalidRequest({ message }),
    ExecutorConflict: () =>
      new Conflict({ message: 'The Connection changed; reload before continuing.' }),
    ExecutorSignInRequired: ({ message }) => new InvalidRequest({ message }),
    ExecutorNotReady: () =>
      new InvalidRequest({ message: 'Authorize this Connection before continuing.' }),
    ExecutorAccessDenied: () =>
      new ServiceUnavailable({
        service: 'connections',
        message: 'Connection authority is unavailable.',
      }),
    ExecutorResourceMissing: ({ resource }) =>
      new InvalidRequest({ message: resourceReason(resource) }),
    ExecutorCopyRetained: unavailable,
    ExecutorTransportFailure: unavailable,
    ExecutorResponseInvalid: unavailable,
    ExecutorExecutionUncertain: unavailable,
  }),
)

/** Transport and protocol failures carry no provider payload or credential in the public error. */
function unavailable() {
  return new ServiceUnavailable({ service: 'connections', message: 'Connections are unavailable.' })
}

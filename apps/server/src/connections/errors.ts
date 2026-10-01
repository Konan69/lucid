import { Match } from 'effect'
import { Conflict, InvalidRequest, ServiceUnavailable } from '@vivid/contracts'
import { ExecutorCallOutcome, type ExecutorFailure } from './executor.ts'

/** An uncertain invocation must never look retryable; expired authority instead asks for reconnection. */
export const callFailure = Match.type<ExecutorFailure>().pipe(
  Match.tagsExhaustive({
    ServiceUnavailable: ({ message }) => ExecutorCallOutcome.cases.Rejected.make({ message }),
    ExecutorRejected: ({ message }) => ExecutorCallOutcome.cases.Rejected.make({ message }),
    ExecutorConflict: () =>
      ExecutorCallOutcome.cases.Rejected.make({
        message: 'The Connection changed; discover its tools again.',
      }),
    ExecutorSignInRequired: ({ message }) => ExecutorCallOutcome.cases.Rejected.make({ message }),
    ExecutorNotReady: () => ExecutorCallOutcome.cases.NotReady.make({}),
    ExecutorAccessDenied: () =>
      ExecutorCallOutcome.cases.Rejected.make({ message: 'The service denied this action.' }),
    ExecutorTransportFailure: () => ExecutorCallOutcome.cases.OutcomeUnknown.make({}),
    ExecutorResponseInvalid: () => ExecutorCallOutcome.cases.OutcomeUnknown.make({}),
    ExecutorExecutionUncertain: () => ExecutorCallOutcome.cases.OutcomeUnknown.make({}),
  }),
)

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
    ExecutorTransportFailure: unavailable,
    ExecutorResponseInvalid: unavailable,
    ExecutorExecutionUncertain: unavailable,
  }),
)

/** Transport and protocol failures carry no provider payload or credential in the public error. */
function unavailable() {
  return new ServiceUnavailable({ service: 'connections', message: 'Connections are unavailable.' })
}

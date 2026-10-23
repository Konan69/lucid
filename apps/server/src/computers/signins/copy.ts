import {
  CopySignInOutcome,
  CopySignInRequest,
  SignInCookie,
  SignInDelivery,
  signInHostMatches,
} from '@vivid/contracts'
import { Effect, Option, Struct } from 'effect'
import { getDomain } from 'tldts'
import type { Actor } from '../../auth/access.ts'
import { ActionOrigin, actionOrigin } from '../../approvals/gate.ts'
import { DeviceRegistry } from '../device.ts'
import { ComputerStore, executionRefusals, executionReason } from '../store.ts'

/** A site-specific native consent precedes reading. The same working Run and allowed Device
 * authority as window work owns the request. Cookie values never reach the public response.
 * Transport refusals and BrowserLocked survive unchanged so the model can name the next step. */
export const copySignIn = Effect.fn('Computer.copySignIn')(function* (
  actor: Actor,
  request: CopySignInRequest,
) {
  // Public suffixes span unrelated people, including privately hosted sites such as github.io.
  // Refuse them before a desktop request or native consent can authorize a cross-site read.
  if (getDomain(request.site, { allowPrivateDomains: true }) === null)
    return CopySignInOutcome.cases.InvalidSite.make({})
  const origin = yield* actionOrigin(actor).pipe(
    Effect.asSome,
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )
  if (Option.isNone(origin) || !ActionOrigin.guards.Run(origin.value))
    return CopySignInOutcome.cases.RunRequired.make({})
  const delivery = yield* (yield* DeviceRegistry).signIn({
    personId: actor.person.id,
    threadId: origin.value.threadId,
    runId: origin.value.runId,
    request,
  })
  if (!SignInDelivery.guards.Collected(delivery)) return delivery
  if (delivery.cookies.length === 0) return CopySignInOutcome.cases.NothingToCopy.make({})
  const belongs = (cookie: SignInCookie) =>
    SignInCookie.fields.scope.match(cookie.scope, {
      Host: ({ host }) => signInHostMatches(request.site, host),
      Domain: ({ domain }) => signInHostMatches(request.site, domain),
    })
  if (!delivery.cookies.every(belongs)) return CopySignInOutcome.cases.Rejected.make({})
  const stillActing = yield* actionOrigin(actor).pipe(
    Effect.asSome,
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )
  if (
    Option.isNone(stillActing) ||
    !ActionOrigin.guards.Run(stillActing.value) ||
    stillActing.value.runId !== origin.value.runId
  )
    return CopySignInOutcome.cases.RunRequired.make({})
  return yield* (yield* ComputerStore).copySignIn(actor.person.id, delivery.cookies).pipe(
    Effect.map((cookies) => CopySignInOutcome.cases.Copied.make({ cookies })),
    Effect.catchTags({
      MachineExecutionUnknown: () =>
        Effect.succeed(CopySignInOutcome.cases.OutcomeUnknown.make({})),
      MachineOperationFailed: () => Effect.succeed(CopySignInOutcome.cases.Rejected.make({})),
      MachineResponseInvalid: () => Effect.succeed(CopySignInOutcome.cases.OutcomeUnknown.make({})),
    }),
    Effect.catchTags(
      Struct.omit(
        executionRefusals((failure) =>
          Effect.succeed(
            CopySignInOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
          ),
        ),
        ['MachineOperationFailed', 'MachineResponseInvalid'],
      ),
    ),
  )
})

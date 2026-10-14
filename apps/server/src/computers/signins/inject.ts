import { SignInCookie } from '@vivid/contracts'
import { Effect, Fiber, Redacted, Schema, Stream } from 'effect'
import {
  MachineOperationFailed,
  MachineResponseInvalid,
  type MachineConversation,
  type MachineFailure,
} from '../machine.ts'
import { signInCommand } from './guest.ts'

/** Host-only cookies omit domain, preserving __Host- rules. Persistent cookies keep their
 * expiry, and unspecified SameSite is omitted so Chromium applies its own default. */
const cdpCookie = (cookie: SignInCookie) => {
  const scope = SignInCookie.fields.scope.match<
    { readonly url: string } | { readonly domain: string }
  >(cookie.scope, {
    Host: ({ host }) => ({ url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}` }),
    Domain: ({ domain }) => ({ domain: `.${domain}` }),
  })
  const expiry = SignInCookie.fields.expiry.match<
    { readonly expires: number } | Record<string, never>
  >(cookie.expiry, {
    Session: () => ({}),
    Persistent: ({ seconds }) => ({ expires: seconds }),
  })
  const sameSite = cookie.sameSite === 'Unspecified' ? {} : { sameSite: cookie.sameSite }
  return {
    name: cookie.name,
    value: Redacted.value(cookie.value),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...scope,
    ...expiry,
    ...sameSite,
  }
}
const Receipt = Schema.Struct({
  cookies: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
})
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(Receipt))

/** A scoped SSH conversation keeps input off the guest filesystem and argv. Decode a bounded
 * count-only receipt after the process exits successfully; never persist or log private output. */
export const injectSignInCookies = Effect.fn('Computer.signIn.inject')(function* (input: {
  readonly pid: number
  readonly cookies: ReadonlyArray<SignInCookie>
  readonly converse: (
    command: string,
  ) => Effect.Effect<MachineConversation, MachineFailure, import('effect/Scope').Scope>
}) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const conversation = yield* input.converse(signInCommand)
      const receipt = yield* conversation.output.pipe(
        Stream.map((chunk) => chunk.slice(0, 4096)),
        Stream.take(2),
        Stream.mkString,
        Effect.forkScoped,
      )
      yield* conversation.say(
        `${JSON.stringify({ pid: input.pid, cookies: input.cookies.map(cdpCookie) })}\n`,
      )
      const ended = yield* conversation.ended
      if (ended.exitCode !== 0 || ended.timedOut)
        return yield* new MachineOperationFailed({ operation: 'sign-in-copy' })
      const stdout = yield* Fiber.join(receipt)
      const result = yield* decodeReceipt(stdout).pipe(
        Effect.mapError(() => new MachineResponseInvalid({ operation: 'sign-in-copy' })),
      )
      if (result.cookies !== input.cookies.length)
        return yield* new MachineResponseInvalid({ operation: 'sign-in-copy' })
      return result.cookies
    }),
  )
})

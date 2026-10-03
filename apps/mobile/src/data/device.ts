import { Data, Duration, Effect, Option, Redacted, Ref, Schedule, Schema, Stream } from 'effect'

/**
 * Signing a phone in with a code: the OAuth device authorization grant (RFC 8628) as Better
 * Auth's `deviceAuthorization` plugin serves it.
 *
 * The phone asks the server for a code and shows it. Someone already signed in on another device
 * enters it there (Settings → Devices). Meanwhile the phone asks the server, at the pace the
 * server set, whether that has happened; the answer that says yes carries the session token.
 * This is the reason a phone can reach a Vivid running on the Person's own machine with no
 * password typed into it.
 *
 * Everything here is pure: the transport that actually talks to a server is passed in, and time
 * is Effect's clock. The asking is the one protocol-mandated wait in the app; nothing else polls.
 *
 * Endpoint payloads verified against the installed plugin source,
 * `better-auth/dist/plugins/device-authorization/routes.mjs` (better-auth 1.7.5).
 */

/** Names this app to the server. The server records it with the code and checks it on exchange. */
export const CLIENT_ID = 'vivid-mobile'

/** The grant type RFC 8628 §3.4 requires on the token request. */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * What came back from one request, before anything has read it. A request that got no answer at
 * all is a different thing from an answer that says no, and the two are paced differently.
 */
export type Wire = Data.TaggedEnum<{
  Answered: { readonly ok: boolean; readonly body: string }
  Unreachable: {}
}>
export const Wire = Data.taggedEnum<Wire>()

/** The two requests of the grant. Neither fails: what went wrong is in the `Wire` it returns. */
export interface PairingTransport {
  readonly requestCode: Effect.Effect<Wire>
  readonly askToken: (deviceCode: Redacted.Redacted) => Effect.Effect<Wire>
}

/** Why an exchange ended without a session. Each has its own sentence on the sign-in screen. */
export type Ending = 'expired' | 'denied' | 'refused' | 'unreachable'

/**
 * Where an exchange stands, which is exactly what the screen draws.
 *
 * - `Asking`: waiting for the server to issue a code.
 * - `Waiting`: the code is on screen and the phone is asking whether it has been entered.
 * - `Approved`: it was entered; this is the session's token.
 * - `Ended`: it will not complete, and a new code is needed to try again.
 */
export type Pairing = Data.TaggedEnum<{
  Asking: {}
  Waiting: { readonly userCode: string }
  Approved: { readonly token: Redacted.Redacted }
  Ended: { readonly why: Ending }
}>
export const Pairing = Data.taggedEnum<Pairing>()

// ── Reading the server's answers ───────────────────────────────────────────

const CodeBody = Schema.fromJsonString(
  Schema.Struct({
    device_code: Schema.String,
    user_code: Schema.String,
    /** Seconds until the code stops being accepted. */
    expires_in: Schema.Number,
    /** The least number of seconds to leave between two token requests. */
    interval: Schema.Number,
  }),
)
const TokenBody = Schema.fromJsonString(Schema.Struct({ access_token: Schema.String }))
const RefusalBody = Schema.fromJsonString(Schema.Struct({ error: Schema.String }))

const decodeCode = Schema.decodeUnknownOption(CodeBody)
const decodeToken = Schema.decodeUnknownOption(TokenBody)
const decodeRefusal = Schema.decodeUnknownOption(RefusalBody)

/** A code the server issued, or why it issued none. */
type Code = Data.TaggedEnum<{
  Issued: {
    readonly deviceCode: Redacted.Redacted
    readonly userCode: string
    readonly interval: Duration.Duration
    readonly lifetime: Duration.Duration
  }
  Withheld: { readonly why: Ending }
}>
const Code = Data.taggedEnum<Code>()
type Issued = Data.TaggedEnum.Value<Code, 'Issued'>

const readCode = (wire: Wire): Code =>
  Wire.$match(wire, {
    Unreachable: () => Code.Withheld({ why: 'unreachable' }),
    Answered: ({ ok, body }) =>
      Option.match(ok ? decodeCode(body) : Option.none(), {
        onNone: () => Code.Withheld({ why: 'refused' }),
        onSome: (issued) =>
          Code.Issued({
            deviceCode: Redacted.make(issued.device_code),
            userCode: issued.user_code,
            interval: Duration.seconds(issued.interval),
            lifetime: Duration.seconds(issued.expires_in),
          }),
      }),
  })

/**
 * One answer to "has the code been entered yet?".
 *
 * - `Wait`: not yet. `slower` when the next question must come later than the last one did.
 * - `Done`: the exchange is over, with the state it ended in.
 */
type Poll = Data.TaggedEnum<{
  Wait: { readonly slower: boolean }
  Done: { readonly outcome: Pairing }
}>
const Poll = Data.taggedEnum<Poll>()

/**
 * The error codes RFC 8628 §3.5 gives a token request. Any other code (a wrong client, a code
 * the server never issued) cannot be recovered by asking again, so it ends the exchange.
 */
const REFUSALS = new Map<string, Poll>([
  ['authorization_pending', Poll.Wait({ slower: false })],
  ['slow_down', Poll.Wait({ slower: true })],
  ['expired_token', Poll.Done({ outcome: Pairing.Ended({ why: 'expired' }) })],
  ['access_denied', Poll.Done({ outcome: Pairing.Ended({ why: 'denied' }) })],
])

const REFUSED = Poll.Done({ outcome: Pairing.Ended({ why: 'refused' }) })

const readRefusal = (body: string): Poll =>
  Option.match(decodeRefusal(body), {
    onNone: () => REFUSED,
    onSome: ({ error }) => {
      const known = REFUSALS.get(error)
      return known === undefined ? REFUSED : known
    },
  })

const readGrant = (body: string): Poll =>
  Option.match(decodeToken(body), {
    onNone: () => REFUSED,
    onSome: (grant) =>
      Poll.Done({ outcome: Pairing.Approved({ token: Redacted.make(grant.access_token) }) }),
  })

const readToken = (wire: Wire): Poll =>
  Wire.$match(wire, {
    // RFC 8628 §3.5: a request that timed out is answered by asking less often, not by stopping.
    // The code is still good until it expires.
    Unreachable: () => Poll.Wait({ slower: true }),
    Answered: ({ ok, body }) => (ok ? readGrant(body) : readRefusal(body)),
  })

// ── The exchange ───────────────────────────────────────────────────────────

/** How much longer to leave between questions each time the server says to slow down (§3.5). */
const SLOWER = Duration.seconds(5)

/**
 * Asks until the exchange is over. The first question waits one interval, because nobody can
 * have entered a code that was shown an instant ago; every later one waits the current pace,
 * which only ever lengthens. The code's own lifetime bounds the whole thing, so a server that
 * never says "expired" still cannot keep the phone asking forever.
 */
const settle = Effect.fn('Device.settle')(function* (transport: PairingTransport, code: Issued) {
  const pace = yield* Ref.make(code.interval)
  const ask = transport.askToken(code.deviceCode).pipe(
    Effect.map(readToken),
    Effect.tap((poll) =>
      Poll.$is('Wait')(poll) && poll.slower
        ? Ref.update(pace, (wait) => Duration.sum(wait, SLOWER))
        : Effect.void,
    ),
  )
  const settled = yield* ask.pipe(
    Effect.repeat({
      schedule: Schedule.forever.pipe(Schedule.modifyDelay(() => Ref.get(pace))),
      while: Poll.$is('Wait'),
    }),
    Effect.delay(code.interval),
    Effect.timeoutOption(code.lifetime),
  )
  return Option.match(settled, {
    onNone: () => Pairing.Ended({ why: 'expired' }),
    onSome: (done) => done.outcome,
  })
})

/**
 * One whole exchange as the states the screen draws, in order. It ends after `Approved` or
 * `Ended`. Interrupting the stream (the screen went away, or a new code was asked for) stops the
 * asking mid-wait.
 */
export const pairing = (transport: PairingTransport): Stream.Stream<Pairing> =>
  Stream.concat(
    Stream.succeed<Pairing>(Pairing.Asking()),
    Stream.unwrap(
      Effect.map(transport.requestCode, (wire) =>
        Code.$match(readCode(wire), {
          Withheld: ({ why }) => Stream.succeed<Pairing>(Pairing.Ended({ why })),
          Issued: (code) =>
            Stream.concat(
              Stream.succeed<Pairing>(Pairing.Waiting({ userCode: code.userCode })),
              Stream.fromEffect(settle(transport, code)),
            ),
        }),
      ),
    ),
  )

/**
 * A code the way it is read aloud: in two halves. The server issues eight characters from an
 * alphabet with no look-alikes and accepts them with or without the dash.
 */
export const spellCode = (userCode: string): string => {
  const half = userCode.length / 2
  return Number.isInteger(half) && half >= 3
    ? `${userCode.slice(0, half)}-${userCode.slice(half)}`
    : userCode
}

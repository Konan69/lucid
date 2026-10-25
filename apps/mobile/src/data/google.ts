import {
  PHONE_SIGN_IN_PLACES,
  PhoneSignedIn,
  phoneSignInStartAddress,
  readPhoneSignInReturn,
  SignInAttempt,
  SignInChallenge,
  SignInReturn,
  SignInTrade,
} from '@vivid/contracts/signin'
import { Data, Duration, Effect, Option, Redacted, Schema } from 'effect'
import type { ServerAddress } from './server'

/**
 * Signing this phone in with Google: the phone's part of the contract in
 * `@vivid/contracts/signin`.
 *
 * The Person presses "Continue with Google", their browser opens on Google's account list, they
 * pick an account, and the browser opens the app again, signed in. Nothing is typed, compared or
 * approved.
 *
 * The exchange is the one Better Auth's own phone integration runs (`@better-auth/expo` 1.7.5,
 * the `onSuccess` hook in `refs/better-auth-expo-1.7.5/dist/client.js`): open a browser on the
 * server's sign-in, and read what it hands back on a link in the app's scheme. Three things
 * differ, and each is stated because the reference is otherwise the guide:
 *
 * 1. The reference opens the platform's sign-in sheet (`Browser.openAuthSessionAsync(url, to)`),
 *    which closes itself on the app's link and answers with it. The installed app has no browser
 *    module, and a native module needs a new binary. So the system browser is opened with React
 *    Native's own `Linking.openURL`, and the same link (`vivid://signin`, a scheme the installed
 *    binary registers) makes the system open the app, which hears it as a `url` event. When a
 *    binary is next built, the sheet replaces `Linking.openURL` and nothing on the server
 *    changes.
 * 2. The browser opens the server's own start address (`PHONE_SIGN_IN_PLACES.start`). The
 *    reference first asks the server for Google's address and opens it through an
 *    `/expo-authorization-proxy` hop that sets a cookie; here the start address is that one step.
 * 3. The link carries a one-use code, traded with a secret this app made and never sent. The
 *    reference puts the session cookie on the link, where another app claiming the scheme could
 *    read it.
 *
 * Because the browser is a separate app, nothing tells this one that the Person gave up there.
 * So an attempt is held in memory while they are away, for as long as the server would still
 * honour it, and pressing the button again simply starts a new one in its place.
 *
 * An app the system had to start afresh for the link (`Linking.getInitialURL`) is not handled:
 * the secret lived in memory and went with the old process, so the code on that link can no
 * longer be traded by anyone. The Person presses the button again.
 *
 * Nothing here imports the phone. What a sign-in needs from it (random bytes, a digest, the
 * browser, one request) is passed in as `Phone`, and where it stands is kept by whoever calls
 * (`Desk`); `signing.ts` binds both. So the whole exchange runs in a test without a device.
 */

/**
 * The phone could not do its own part: it gave no random bytes or digest, what it gave is not
 * what the contract takes, or the browser could not be opened.
 */
export class PhoneUnable extends Schema.TaggedError<PhoneUnable>()(
  'PhoneUnable',
  {},
  { title: 'The phone could not run its part of the sign-in' },
) {}

/** The trade got no answer, or none in time. */
export class TradeUnanswered extends Schema.TaggedError<TradeUnanswered>()(
  'TradeUnanswered',
  {},
  { title: 'Trading the code got no answer' },
) {}

/** The answer to one trade request, unread: whether the server said yes, and the body it sent. */
export interface Answer {
  readonly ok: boolean
  readonly body: string
}

/** Everything a sign-in asks of the phone it runs on. */
export interface Phone {
  /** Bytes from the platform's cryptographic random source. */
  readonly random: (count: number) => Effect.Effect<Uint8Array, PhoneUnable>
  /** The SHA-256 digest of a text, in standard base64 with padding, as `expo-crypto` writes it. */
  readonly digest: (text: string) => Effect.Effect<string, PhoneUnable>
  /** Opens an address in the system browser. It answers once the browser has been asked. */
  readonly open: (address: string) => Effect.Effect<void, PhoneUnable>
  /** Posts a JSON body to an address, with no cookie and no token. */
  readonly post: (address: string, body: string) => Effect.Effect<Answer, TradeUnanswered>
}

/**
 * One attempt, as the app holds it while the Person is at the browser: the server it was started
 * on, the secret (wrapped, so it cannot be logged or drawn), and the attempt's name, which the
 * link that comes back must carry.
 */
export interface Attempt {
  readonly server: ServerAddress
  readonly verifier: Redacted.Redacted
  readonly state: SignInAttempt
}

/**
 * Where signing in with Google stands, which is exactly what the first screen draws.
 *
 * - `Idle`: nothing is under way and nothing is left to say.
 * - `Away`: the browser was opened for `attempt` and no link has come back for it. The Person may
 *   be choosing an account, or may have come back without finishing; the app cannot tell, so the
 *   screen looks as it does at rest and the button starts a new attempt.
 * - `Trading`: the link came back with a code, and it is being traded for a session.
 * - `Failed`: it did not finish. Google or the server said no, the trade was refused, or the
 *   phone could not do its part (the browser would not open, for one).
 * - `Unreachable`: the code came back and the trade got no answer.
 * - `Unkept`: the server issued a session and this phone's store would not keep it, so it was
 *   not taken up.
 */
export type Standing = Data.TaggedEnum<{
  Idle: {}
  Away: { readonly attempt: Attempt }
  Trading: {}
  Failed: {}
  Unreachable: {}
  Unkept: {}
}>
export const Standing = Data.taggedEnum<Standing>()

/** What a sign-in needs from whoever runs it: where it stands, kept and shown, and the way in. */
export interface Desk<Refusal> {
  /** Where the sign-in stands now. */
  readonly standing: () => Standing
  /** Puts where it stands on the screen, and keeps it. */
  readonly show: (next: Standing) => void
  /** Takes up the session the server issued, which the phone's store can refuse. */
  readonly adopt: (server: ServerAddress, token: Redacted.Redacted) => Effect.Effect<void, Refusal>
}

const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Bytes as base64url without padding (RFC 4648 section 5), which is how the contract writes the
 * secret. It is written out here because a phone has no `Buffer`, and what its JavaScript engine
 * offers in its place takes text, not bytes.
 *
 * The bytes are read as one run of bits, six at a time. `held` keeps the bits not yet written
 * (never more than five after each byte), and a last short group is padded with zero bits.
 */
export const base64url = (bytes: Uint8Array): string => {
  let text = ''
  let held = 0
  let bits = 0
  for (const byte of bytes) {
    held = (held << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      text += URL_SAFE.charAt((held >> bits) & 63)
    }
    held &= (1 << bits) - 1
  }
  return bits === 0 ? text : text + URL_SAFE.charAt((held << (6 - bits)) & 63)
}

/**
 * A digest in standard base64 as the contract's challenge writes it: the two characters an
 * address would read as its own swapped for their URL-safe ones, and the padding dropped. This is
 * PKCE's `S256` form (RFC 7636 section 4.2), which the server computes over the secret's text
 * and compares.
 */
export const challengeText = (digest: string): string =>
  digest.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

const LETTERS_AND_DIGITS = URL_SAFE.slice(0, 62)

/**
 * The name of one attempt: a letter or digit for each byte given. Sixteen bytes make the sixteen
 * characters the contract asks for. A byte has 256 values and there are 62 characters, so the
 * first eight characters come up slightly more often; that is fine for a name, which only has to
 * differ from another attempt's and is not what keeps the code safe. The secret is.
 */
export const attemptName = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => LETTERS_AND_DIGITS.charAt(byte % 62)).join('')

/**
 * How long the trade may take. It is one small request, so a quarter of a minute without an
 * answer means it is not coming, and the button stops saying it is signing the Person in. The
 * desktop window gives its trade the same (`TRADE_WITHIN` in the web app's `data/signin.ts`).
 */
export const TRADE_WITHIN = Duration.seconds(15)

const decodeChallenge = Schema.decodeUnknownEffect(SignInChallenge)
const decodeAttempt = Schema.decodeUnknownEffect(SignInAttempt)
const encodeTrade = Schema.encodeEffect(Schema.fromJsonString(SignInTrade))
const decodeSignedIn = Schema.decodeUnknownEffect(Schema.fromJsonString(PhoneSignedIn))

const unable = () => new PhoneUnable({})

/** How a trade ended: with the session's token, or with which way it fell short. */
type Traded = Data.TaggedEnum<{
  Granted: { readonly token: Redacted.Redacted }
  Refused: {}
  Unanswered: {}
}>
const Traded = Data.taggedEnum<Traded>()

/**
 * What one attempt starts with: the attempt the app keeps, and the public digest of its secret,
 * which goes on the address.
 *
 * The secret is 32 random bytes as base64url, wrapped as soon as it exists, and the digest is
 * taken over that text. What the phone hands back for the digest and the bytes is input from a
 * native module, so the challenge and the name are decoded with the contract's schemas once,
 * here, before anything is opened: an attempt the server would refuse is never started.
 */
const beginning = Effect.fn('Google.beginning')(function* (phone: Phone, server: ServerAddress) {
  const verifier = Redacted.make(base64url(yield* phone.random(32)))
  const digest = yield* phone.digest(Redacted.value(verifier))
  const challenge = yield* decodeChallenge(challengeText(digest)).pipe(Effect.mapError(unable))
  const state = yield* decodeAttempt(attemptName(yield* phone.random(16))).pipe(
    Effect.mapError(unable),
  )
  const attempt: Attempt = { server, verifier, state }
  return { attempt, challenge }
})

/**
 * The return a link stands for, when it is this attempt's. The link is read with the contract's
 * own reader, and then its `state` is compared with the attempt's. A link in the app's scheme can
 * be opened by anything on the phone, and an earlier attempt's browser tab can still finish; a
 * return that names another attempt is neither an answer nor a failure of this one.
 */
export const returnFor = (attempt: Attempt, link: string): Option.Option<SignInReturn> =>
  Option.filter(readPhoneSignInReturn(link), (back) => back.state === attempt.state)

/**
 * Trades the code and the secret for a session's token: `POST` to `PHONE_SIGN_IN_PLACES.trade`
 * on the attempt's server (`apps/server/src/auth/signin.ts`), which answers 200 with the token
 * or 401. The secret is written into the request body here and nowhere else.
 *
 * A refusal, and a yes whose body does not read, are both `Refused`: the code is spent either
 * way, and the only way forward is a new attempt. No answer within `TRADE_WITHIN` is
 * `Unanswered`.
 */
const trading = Effect.fn('Google.trading')(
  function* (phone: Phone, attempt: Attempt, code: SignInTrade['code']) {
    const trade: SignInTrade = { code, state: attempt.state, verifier: attempt.verifier }
    const body = yield* encodeTrade(trade).pipe(Effect.mapError(unable))
    const answer = yield* phone.post(`${attempt.server}${PHONE_SIGN_IN_PLACES.trade}`, body).pipe(
      Effect.timeoutOrElse({
        duration: TRADE_WITHIN,
        orElse: () => Effect.fail(new TradeUnanswered({})),
      }),
    )
    if (!answer.ok) return Traded.Refused()
    return yield* decodeSignedIn(answer.body).pipe(
      Effect.map(({ token }) => Traded.Granted({ token })),
      Effect.mapError(unable),
    )
  },
  Effect.catchTags({
    PhoneUnable: () => Effect.succeed(Traded.Refused()),
    TradeUnanswered: () => Effect.succeed(Traded.Unanswered()),
  }),
)

/**
 * Signing in with Google on one phone: the press that starts an attempt, and the link that ends
 * one. Neither ever fails; every way it can go is a `Standing`, shown as it is reached.
 */
export function makeGoogle<Refusal>(phone: Phone, desk: Desk<Refusal>) {
  /**
   * Opens the browser and retains the attempt until its own return, a new press or the front
   * door leaving. Google's human step has no client deadline: the server creates its expiring
   * trade grant after the browser callback, not when this press begins.
   */
  const start = Effect.fn('Google.start')(
    function* (server: ServerAddress) {
      if (Standing.$is('Trading')(desk.standing())) return
      desk.show(Standing.Idle())
      const { attempt, challenge } = yield* beginning(phone, server)
      desk.show(Standing.Away({ attempt }))
      yield* phone.open(phoneSignInStartAddress(server, { challenge, state: attempt.state }))
    },
    Effect.catchTag('PhoneUnable', () => Effect.sync(() => desk.show(Standing.Failed()))),
  )

  /** Trades a code that came back, and takes up the session it is good for. */
  const finishing = Effect.fn('Google.finishing')(function* (
    attempt: Attempt,
    code: SignInTrade['code'],
  ) {
    desk.show(Standing.Trading())
    const traded = yield* trading(phone, attempt, code)
    yield* Traded.$match(traded, {
      Granted: ({ token }) =>
        desk.adopt(attempt.server, token).pipe(
          Effect.match({
            onFailure: () => desk.show(Standing.Unkept()),
            onSuccess: () => desk.show(Standing.Idle()),
          }),
        ),
      Refused: () => Effect.sync(() => desk.show(Standing.Failed())),
      Unanswered: () => Effect.sync(() => desk.show(Standing.Unreachable())),
    })
  })

  /**
   * A link the system opened the app with. It is acted on only while an attempt is being waited
   * on, and only when it is that attempt's return (`returnFor`); every other link is ignored and
   * changes nothing, on the screen or anywhere else.
   *
   * The attempt ends here whichever way it came back: `Trading` or `Failed` replaces `Away`, so
   * the secret is let go and the same link arriving twice is answered once.
   */
  const returned = Effect.fn('Google.returned')(function* (link: string) {
    const standing = desk.standing()
    if (!Standing.$is('Away')(standing)) return
    const { attempt } = standing
    const back = returnFor(attempt, link)
    if (Option.isNone(back)) return
    yield* SignInReturn.match(back.value, {
      Granted: ({ code }) => finishing(attempt, code),
      Failed: () => Effect.sync(() => desk.show(Standing.Failed())),
    })
  })

  return { start, returned }
}

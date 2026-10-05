import { Data, Option, Schema } from 'effect'

/**
 * What the address bar says about signing in with Google, and what to tell the Person about it.
 * Everything here is pure: the address goes in as text and comes out decoded, so none of it needs
 * a browser, a server or Better Auth to be checked.
 *
 * Signing in with Google leaves the page and comes back, so the address is the only thing that
 * survives the trip. Two marks travel in it, each put there by this module:
 *
 * - `signin=returned`: Google sign-in came back without signing anyone in. Better Auth adds
 *   `error=<code>` beside it (`redirectOnError` in better-auth 1.7.5 `dist/api/routes/callback.mjs`).
 * - `joined=google`: this is the first time this Person signed in, so there is an account that
 *   has no time zone yet (Better Auth sends a new account to `newUserCallbackURL`).
 */

/** How a Google sign-in went wrong, in the cases a Person is told different things for. */
export type GoogleOutcome = 'Cancelled' | 'NotLinked' | 'NotSetUp' | 'Unreachable' | 'Failed'

/**
 * Better Auth's codes for the outcomes Vivid words differently, read from the installed source
 * (better-auth 1.7.5) and matched by code, never by a message:
 *
 * - `access_denied`: Google's own OAuth answer when the Person closes or declines its screen. The
 *   callback passes the provider's `error` through unchanged.
 * - `account_not_linked`: an account with this email already exists and has a password, and its
 *   email was never verified, so Better Auth will not attach Google to it
 *   (`handleOAuthUserInfo` in `dist/oauth2/link-account.mjs` answers "account not linked", which
 *   the callback joins with underscores). That refusal is what stops someone registering another
 *   Person's email first and waiting for them to arrive with Google.
 * - `oauth_provider_not_found`, on the way back, and `PROVIDER_NOT_FOUND`, the answer to the
 *   request that starts a sign-in (`dist/api/routes/sign-in.mjs`): this server was not given a
 *   Google client.
 *
 * Every other code (a state that expired, a code Google would not exchange, a profile with no
 * email) is the same thing to a Person: it did not work, try again.
 */
const OUTCOMES: ReadonlyMap<string, GoogleOutcome> = new Map([
  ['access_denied', 'Cancelled'],
  ['account_not_linked', 'NotLinked'],
  ['oauth_provider_not_found', 'NotSetUp'],
  ['PROVIDER_NOT_FOUND', 'NotSetUp'],
])

/** The outcome a Better Auth code stands for. */
export const outcomeOf = (code: string): GoogleOutcome =>
  Option.getOrElse(Option.fromUndefinedOr(OUTCOMES.get(code)), () => 'Failed' as const)

/**
 * What the Person is told. `quiet` is for the one outcome they chose themselves: it is said, in
 * case the screen closed by accident, but not as a fault.
 */
export const SAID = {
  Cancelled: { tone: 'quiet', message: 'Google sign-in was cancelled.' },
  NotLinked: {
    tone: 'danger',
    message: 'An account with this email already exists. Sign in with its password.',
  },
  NotSetUp: {
    tone: 'danger',
    message: 'Google sign-in is not set up on this Vivid. Use your email and password.',
  },
  Unreachable: { tone: 'danger', message: 'Vivid could not be reached. Try again.' },
  Failed: { tone: 'danger', message: 'Could not sign in with Google. Try again.' },
} as const satisfies Record<GoogleOutcome, { tone: 'quiet' | 'danger'; message: string }>

/**
 * Where the address stands on Google sign-in.
 *
 * - `Plain`: it says nothing about it.
 * - `Returned`: a Google sign-in came back without signing anyone in, and why.
 */
export type Standing = Data.TaggedEnum<{
  Plain: {}
  Returned: { readonly outcome: GoogleOutcome }
}>
export const Standing = Data.taggedEnum<Standing>()

/** The marks this module puts in an address. Anything else in it belongs to the place itself. */
const MARKS = ['signin', 'error', 'error_description', 'joined'] as const

const Marks = Schema.Struct({
  signin: Schema.optionalKey(Schema.Literal('returned')),
  error: Schema.optionalKey(Schema.String),
  joined: Schema.optionalKey(Schema.Literal('google')),
})
const decodeMarks = Schema.decodeUnknownOption(Marks)

/**
 * A stand-in origin to read a path against. An address that names another site (`//elsewhere/x`,
 * `https://elsewhere/x`) resolves to a different origin and is refused, the same rule `reload`
 * keeps for where it goes after signing in.
 */
const BASE = 'https://vivid.invalid'

const parse = (address: string) =>
  Option.filter(
    Option.liftThrowable((value: string) => new URL(value, BASE))(address),
    (target) => target.origin === BASE,
  )

const place = (target: URL) => `${target.pathname}${target.search}`

/** The address with one mark set. An address that is not a place in this app becomes the first screen. */
const marked = (address: string, mark: (typeof MARKS)[number], value: string) =>
  Option.match(parse(address), {
    onNone: () => '/',
    onSome: (target) => {
      target.searchParams.set(mark, value)
      return place(target)
    },
  })

const standingOf = {
  onNone: () => Standing.Plain(),
  onSome: (marks: typeof Marks.Type): Standing => {
    if (marks.signin === 'returned' && marks.error !== undefined)
      return Standing.Returned({ outcome: outcomeOf(marks.error) })
    return Standing.Plain()
  },
}

/**
 * Reads an address: where the Person was going, with this module's marks taken off, and what the
 * marks said. The destination is what every way of signing in goes to afterwards, so an error
 * from one attempt is never carried into the app by the next.
 *
 * A mark with a value this module never writes is treated as no mark. `signin=returned` with no
 * code says nothing went wrong, so it reads as `Plain`.
 */
export const readAddress = (
  address: string,
): { readonly destination: string; readonly standing: Standing } =>
  Option.match(parse(address), {
    onNone: () => ({ destination: '/', standing: Standing.Plain() }),
    onSome: (target) => {
      const marks = decodeMarks(Object.fromEntries(target.searchParams))
      for (const mark of MARKS) target.searchParams.delete(mark)
      return { destination: place(target), standing: Option.match(marks, standingOf) }
    },
  })

/**
 * The three addresses Better Auth is given for one Google sign-in, each a place in this app:
 * where a Person who already has an account lands, where one whose account was just made lands
 * (the same place, marked so the time zone is adopted), and where a failure lands (the same
 * place again, marked so the welcome says why).
 */
export const googleAddresses = (address: string) => {
  // Marks an earlier attempt left in the address are taken off first, so none of the three can
  // carry an old error into the next landing.
  const { destination } = readAddress(address)
  return {
    callbackURL: destination,
    newUserCallbackURL: marked(destination, 'joined', 'google'),
    errorCallbackURL: marked(destination, 'signin', 'returned'),
  }
}

/**
 * Whether this address is the landing of a first sign-in with Google, and if so the address
 * without the mark, to put back in the address bar once it has been acted on.
 */
export const firstArrival = (address: string): Option.Option<string> =>
  Option.flatMap(parse(address), (target) => {
    if (target.searchParams.get('joined') !== 'google') return Option.none()
    target.searchParams.delete('joined')
    return Option.some(place(target))
  })

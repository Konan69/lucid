import { Redacted, Schema } from 'effect'

/** DNS host syntax. The server additionally rejects public/private suffixes before dispatch. */
export const SignInSite = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u),
).pipe(Schema.brand('SignInSite'))
export type SignInSite = typeof SignInSite.Type

/** Sources are chosen explicitly. A refusal never silently reads a different browser. */
export const SignInBrowser = Schema.Literals(['Chrome', 'Helium'])
export type SignInBrowser = typeof SignInBrowser.Type

/** A browser's displayed profile name, or Default for its default profile. The adapter maps
 * names to enumerated contained directories; callers never supply a filesystem path. */
export const SignInProfile = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^(?!\.{1,2}$)[^/\\\p{Cc}]+$/u),
).pipe(Schema.brand('SignInProfile'))
export type SignInProfile = typeof SignInProfile.Type

/** CDP cookie parameters preserve host-only scope by using a URL instead of a domain. Values
 * are redacted inside every process and encoded only on the private device and guest channels. */
export const SignInCookie = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(4096)),
  value: Schema.RedactedFromValue(Schema.String.check(Schema.isMaxLength(16_384))),
  scope: Schema.TaggedUnion({
    Host: { host: SignInSite },
    Domain: { domain: SignInSite },
  }),
  path: Schema.String.check(Schema.isPattern(/^\//u), Schema.isMaxLength(4096)),
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  sameSite: Schema.Literals(['Unspecified', 'None', 'Lax', 'Strict']),
  expiry: Schema.TaggedUnion({ Session: {}, Persistent: { seconds: Schema.Finite } }),
})
export type SignInCookie = typeof SignInCookie.Type

/** Only a whole label boundary counts. `evil-github.com` never matches `github.com`. */
export const signInHostMatches = (site: SignInSite, host: string) => {
  const bare = host.startsWith('.') ? host.slice(1) : host
  return bare === site || bare.endsWith(`.${site}`)
}

/** These refusals travel unchanged from the cookie source to the Run. Closing a browser fixes
 * only BrowserLocked; consent, unsupported encryption and an empty jar have different remedies. */
const sourceRefusals = {
  BrowserLocked: { browser: SignInBrowser },
  PermissionDenied: { browser: SignInBrowser },
  KeyUnavailable: { browser: SignInBrowser },
  UnsupportedEncryption: { browser: SignInBrowser },
  UnsupportedCookieScope: { browser: SignInBrowser },
  SourceMissing: { browser: SignInBrowser },
  Unreadable: { browser: SignInBrowser },
  NothingToCopy: {},
  Declined: {},
}
export const SignInRead = Schema.TaggedUnion({
  Collected: {
    cookies: Schema.Array(SignInCookie).check(
      Schema.isMaxLength(1000),
      Schema.makeFilter(
        (cookies) =>
          // JSON may escape one UTF-16 code unit to six bytes. Keeping input below 96 Ki units,
          // including conservative per-cookie metadata, bounds both private JSON envelopes below 1 MiB.
          cookies.reduce(
            (units, cookie) =>
              units +
              cookie.name.length +
              Redacted.value(cookie.value).length +
              cookie.path.length +
              400,
            0,
          ) <=
          96 * 1024,
      ),
    ),
  },
  ...sourceRefusals,
})
export type SignInRead = typeof SignInRead.Type

export const CopySignInRequest = Schema.Struct({
  site: SignInSite,
  browser: SignInBrowser,
  profile: SignInProfile,
})
export type CopySignInRequest = typeof CopySignInRequest.Type

/** Cookies never appear in a public RPC result or model receipt. A fresh invocation is the
 * retry after the Person quits the browser; neither the server nor desktop polls for it. */
const transportRefusals = {
  InvalidSite: {},
  NotAnswered: {},
  NotConnected: {},
  Busy: {},
  RunRequired: {},
  Unavailable: { reason: Schema.String },
  Rejected: {},
  OutcomeUnknown: {},
}
export const CopySignInOutcome = Schema.TaggedUnion({
  Copied: { cookies: Schema.Int.check(Schema.isGreaterThan(0)) },
  ...sourceRefusals,
  ...transportRefusals,
})
export type CopySignInOutcome = typeof CopySignInOutcome.Type

/** Internal desktop receipt. Collected is consumed by the server before any public response. */
export const SignInDelivery = Schema.TaggedUnion({
  Collected: SignInRead.cases.Collected.fields,
  ...sourceRefusals,
  ...transportRefusals,
})
export type SignInDelivery = typeof SignInDelivery.Type

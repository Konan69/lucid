import { Redacted } from 'effect'
import { fetch as expoFetch } from 'expo/fetch'

/**
 * The app's one way of making an HTTP request.
 *
 * It is Expo's `fetch` rather than React Native's because a conversation arrives as a stream and
 * React Native's own `fetch` only hands over a body once it has all of it.
 *
 * Every request leaves without cookies. A phone is signed in by the bearer token it sends, and
 * the operating system's cookie jar would otherwise quietly keep the session cookie Better Auth
 * also sets. That cookie would then ride along on later requests, where Better Auth treats a
 * request with a cookie and no `Origin` header as a forged one and refuses it; and it would keep
 * the device signed in after the app had forgotten its token.
 */
export const request = (
  address: string,
  init: {
    readonly method: 'GET' | 'POST'
    readonly headers: Readonly<Record<string, string>>
    readonly body?: string | FormData
    readonly signal?: AbortSignal
  },
) => expoFetch(address, { ...init, credentials: 'omit' })

/**
 * The same transport in the form Flue's client takes: the standard `fetch` signature. Flue only
 * ever calls it with an address string and an init whose body is a string.
 */
// SAFETY: expo/fetch implements the Fetch API (its response class `implements Response`); the
// two signatures differ only in init fields Flue does not use.
export const streamingFetch = ((address: string, init: Parameters<typeof expoFetch>[1]) =>
  expoFetch(address, { ...init, credentials: 'omit' })) as typeof fetch

/**
 * The header that says who is asking. This and Flue's client are the only places a session's
 * token is unwrapped.
 */
export const bearer = (token: Redacted.Redacted) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
})

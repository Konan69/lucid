import { Redacted } from 'effect'
import { fetch as expoFetch } from 'expo/fetch'

/**
 * The app's one way of making an HTTP request.
 *
 * It is Expo's `fetch` rather than React Native's because a body can arrive as a stream (it did
 * when a conversation was read over HTTP), and React Native's own `fetch` only hands one over
 * once it has all of it.
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
 * The header that says who is asking: on a request, on the socket's upgrade (`data/socket.ts`)
 * and beside a picture kept on the Person's server (`data/message.ts`). This is the one place a
 * session's token is unwrapped for the server.
 */
export const bearer = (token: Redacted.Redacted) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
})

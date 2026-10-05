import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'

/** The scheme the `bearer` plugin reads, compared the way it compares it: without regard to case. */
const BEARER = 'bearer '

/**
 * Admits only the call this route exists for: the web app, on the server's own origin, trading a
 * bearer token, with nothing else in the request.
 *
 * Better Auth's own origin check does not cover this caller. It guards requests that carry a
 * cookie, and a bearer-only request carries none, so without this any page on the internet that
 * held a token could have a cookie set for it. The three refusals, in order:
 *
 * - 403 unless `Origin` is exactly the server's public origin, the same value Better Auth is
 *   given as `trustedOrigins`. A browser always sends `Origin` on a POST and a page cannot forge
 *   it; a request with none is not the web app.
 * - 401 unless the request carries `Authorization: Bearer`. A caller who has only a cookie has
 *   nothing to trade, and answering it would make this a second, unguarded way to refresh one.
 * - 400 if the request has a body. The route takes no input, so a body is never the web app's.
 *   It is read from the headers that frame one (`carriesBody`), not from `request.body`: the
 *   server hands Better Auth a body stream for every POST, an empty one included
 *   (`toWebResult` in effect 4.0.0-rc.116 `unstable/http/HttpServerRequest.ts`).
 *
 * It runs before `sessionMiddleware`, so a request from elsewhere learns nothing about whether
 * its token is good.
 */
/**
 * Whether a request frames a body. HTTP/1.1 allows one only with a `Content-Length` or a
 * `Transfer-Encoding` (RFC 9112 §6), so a request with neither, or with a length of zero, has none.
 */
const carriesBody = (headers: Headers) => {
  const length = headers.get('content-length')
  return headers.has('transfer-encoding') || (length !== null && length.trim() !== '0')
}

const tradeOnly = (origin: string) =>
  createAuthMiddleware((ctx) => {
    const request = ctx.request
    if (request === undefined || request.headers.get('origin') !== origin)
      return Promise.reject(ctx.error('FORBIDDEN', { message: 'Origin not allowed' }))
    const authorization = request.headers.get('authorization')
    if (authorization === null || !authorization.toLowerCase().startsWith(BEARER))
      return Promise.reject(ctx.error('UNAUTHORIZED', { message: 'A bearer token is required' }))
    if (carriesBody(request.headers))
      return Promise.reject(ctx.error('BAD_REQUEST', { message: 'This request takes no body' }))
    return Promise.resolve()
  })

/**
 * `POST /api/auth/adopt-session`: gives the caller the session cookie for the session whose
 * bearer token it holds. It answers 204 and says nothing; the cookie is the answer.
 *
 * It exists for the desktop app signing in with Google. That window cannot run Google's sign-in
 * itself, so it signs in the way a phone does: a device-code exchange whose approval happens in
 * the system browser. The exchange ends with a session token in a response body
 * (`deviceToken` in `better-auth/dist/plugins/device-authorization/routes.mjs` answers
 * `access_token: session.token` and sets no cookie). A phone keeps that token and sends it as a
 * bearer on every call. The desktop window is the web app, which is authenticated by cookie
 * everywhere, the live WebSocket included, and a browser cannot put a header on a WebSocket. So
 * the window trades the token for the cookie of the same session, once, here.
 *
 * Nothing in Better Auth 1.7.5 does that trade without also changing something: every built-in
 * route that calls `setSessionCookie` either starts a new session or writes to the session or the
 * Person (`update-session` refuses an empty body, `get-session` sets it only when it extends the
 * session). This is the missing route, built only from Better Auth's public plugin API:
 *
 * - `tradeOnly` decides who may ask at all (above). `origin` is the server's public origin.
 * - `sessionMiddleware` (`better-auth/api`, `dist/api/routes/session.mjs`) is what authenticates
 *   the caller. The `bearer` plugin's before-hook (`dist/plugins/bearer/index.mjs`) has by then
 *   verified the token and placed it on the request as the session cookie. No session is a 401.
 * - `setSessionCookie` (`better-auth/cookies`, `dist/cookies/index.mjs`) signs the session's
 *   token with the instance's secret and sets it with the instance's own cookie name and
 *   attributes. Nothing is signed or named by hand here.
 *
 * It grants nothing new: whoever can call it already holds the session's token and could act
 * with it. No session is created, so the cookie and the token end together when either is signed
 * out.
 */
export const sessionCookie = (options: { readonly origin: string }) =>
  ({
    id: 'vivid-session-cookie',
    endpoints: {
      adoptSession: createAuthEndpoint(
        '/adopt-session',
        // `disableBody`: the router does not read a body for this route. Without it better-call
        // 1.4.0 answers 415 to every real request, because the body stream the server always
        // supplies for a POST has no `Content-Type` (`getBody` in `dist/utils.mjs`).
        {
          method: 'POST',
          disableBody: true,
          use: [tradeOnly(options.origin), sessionMiddleware],
        },
        (ctx) =>
          // Nothing is returned: better-call 1.4.0 writes a returned `null` as the JSON body
          // "null" (`dist/to-response.mjs`), and a 204 may not carry a body.
          setSessionCookie(ctx, ctx.context.session).then(() => ctx.setStatus(204)),
      ),
    },
  }) satisfies BetterAuthPlugin

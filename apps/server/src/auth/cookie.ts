import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'

/**
 * `POST /api/auth/adopt-session`: gives the caller the session cookie for the session it already
 * holds. It answers 204 and says nothing; the cookie is the answer.
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
 * - `sessionMiddleware` (`better-auth/api`, `dist/api/routes/session.mjs`) is what authenticates
 *   the caller. The `bearer` plugin's before-hook (`dist/plugins/bearer/index.mjs`) has by then
 *   verified an `Authorization: Bearer` token and placed it on the request as the session cookie,
 *   so a bearer caller and a cookie caller arrive here the same way. No session is a 401.
 * - `setSessionCookie` (`better-auth/cookies`, `dist/cookies/index.mjs`) signs the session's
 *   token with the instance's secret and sets it with the instance's own cookie name and
 *   attributes. Nothing is signed or named by hand here.
 *
 * It grants nothing new: whoever can call it already holds the session's token and could act
 * with it. No session is created, so the cookie and the token end together when either is signed
 * out. A caller that already has the cookie is given the same cookie again.
 */
export const sessionCookie = () =>
  ({
    id: 'vivid-session-cookie',
    endpoints: {
      adoptSession: createAuthEndpoint(
        '/adopt-session',
        { method: 'POST', use: [sessionMiddleware] },
        (ctx) =>
          // Nothing is returned: better-call 1.4.0 writes a returned `null` as the JSON body
          // "null" (`dist/to-response.mjs`), and a 204 may not carry a body.
          setSessionCookie(ctx, ctx.context.session).then(() => ctx.setStatus(204)),
      ),
    },
  }) satisfies BetterAuthPlugin

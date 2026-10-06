import { createAuthClient } from 'better-auth/client'

/**
 * Better Auth's own browser client, for the parts of signing in that Better Auth already does and
 * Vivid must not rebuild: starting a sign-in with Google, which is a POST that answers with the
 * address to go to, and the redirect that follows it.
 *
 * It is given no address. With none, the installed client (better-auth 1.7.5,
 * `dist/client/config.mjs` and `getBaseURL` in `dist/utils/url.mjs`) asks the page's own origin at
 * `/api/auth`, cookies included, which is the single origin the web app is served from in
 * development (through Vite), in production and in the desktop app. Writing an origin here would
 * bake it into the bundle.
 *
 * It is the plain client, not `better-auth/react`: nothing here reads the session through it. Who
 * is signed in is one live query (`live.me`), and this client asks for a session only when
 * something subscribes to its store, which nothing does.
 */
export const auth = createAuthClient()

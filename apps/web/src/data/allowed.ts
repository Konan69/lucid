/**
 * The closed sets that are the web app's own, for `scrub.ts`: the files its build makes, its
 * routes, and the SDK integrations it turns on. A path, an address or a name in an error report
 * is kept only when it is one of these.
 *
 * Each list is read off something real, named beside it. When that thing changes (a new route, a
 * new build output) the list changes with it; until it does, the new value reports as
 * `[removed]`, which is the safe way to be out of date.
 */

/**
 * One allowed shape of a path, and the form it is kept in. The pattern is matched against the
 * whole path, after `readable` in `scrub.ts` has unescaped it and taken off its host and query.
 * The form is what is written to the report: a fixed string, or the parts of the pattern it
 * names (`$1`). A changing part of a route is never named, so it cannot be kept.
 */
export type Allowed = readonly [pattern: RegExp, form: string]

/**
 * The files of the build that can be in a stack: the scripts Vite writes to `dist/assets`, each
 * `<name>-<hash>.js` with Vite's eight-character hash (`ls apps/web/dist/assets`:
 * `index-6j2QNZhH.js`, `chevron-right-BBgoygqL.js`, `rolldown-runtime-hePW80VL.js`), and the two
 * names an engine gives code that has no file.
 */
export const FILES: ReadonlyArray<Allowed> = [
  [/^\/assets\/([A-Za-z][A-Za-z0-9_-]{0,63})-([A-Za-z0-9_-]{8})\.js$/u, '/assets/$1-$2.js'],
  [/^<anonymous>$/u, '<anonymous>'],
  [/^\[native code\]$/u, '[native code]'],
]

/**
 * The first part of every path the server answers under `/api`, from the addresses the apps and
 * the contracts name (a search for `/api/` in `packages/contracts`, `packages/client` and each
 * app's `src`). Only this part of a request's address is kept: what follows it names a Thread, a
 * Person or a file.
 */
const API = [
  'auth',
  'vivid',
  'library',
  'rpc',
  'connections',
  'live',
  'updates',
  'hooks',
  'faults',
  'computer',
  'organizations',
]

/**
 * Where a page or a request can be. The pages are the app's route table (`parseRoute` and
 * `pathOf` in `route.ts`), with the id each one carries replaced; the requests are `API`.
 */
export const PLACES: ReadonlyArray<Allowed> = [
  [/^\/?$/u, '/'],
  [/^\/t\/[^/]+\/?$/u, '/t/:id'],
  [/^\/routines\/?$/u, '/routines'],
  [/^\/library\/?$/u, '/library'],
  [/^\/projects\/?$/u, '/projects'],
  [/^\/projects\/[^/]+\/?$/u, '/projects/:id'],
  [/^\/invite\/[^/]+\/?$/u, '/invite/:id'],
  [/^\/device\/?$/u, '/device'],
  [/^\/health\/?$/u, '/health'],
  [new RegExp(`^/api/(${API.join('|')})(?:/.*)?$`, 'su'), '/api/$1'],
]

/** The sentences an SDK writes that may be a report's message. The web SDK writes none. */
export const MESSAGES: ReadonlyArray<Allowed> = []

/**
 * The SDK integrations this app runs, by the names the SDK gives them: what
 * `getDefaultIntegrations({})` of `@sentry/react` 11.1.0 returns, less `BrowserSession`, which
 * `telemetry.ts` leaves out, and with `ScopeToMain`, which `@sentry/electron/renderer` adds when
 * the pages run inside the desktop app (and where it takes `CultureContext` out).
 */
export const INTEGRATIONS: ReadonlySet<string> = new Set([
  'EventFilters',
  'FunctionToString',
  'ConversationId',
  'BrowserApiErrors',
  'Breadcrumbs',
  'Console',
  'GlobalHandlers',
  'LinkedErrors',
  'Dedupe',
  'HttpContext',
  'CultureContext',
  'ScopeToMain',
])

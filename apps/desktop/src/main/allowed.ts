/**
 * The closed sets that are the desktop app's own, for `scrub.ts`: the files its build makes, the
 * routes of the pages its window draws, the one sentence its SDK writes, and the SDK integrations
 * it turns on. A path, an address or a name in an error report
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
 * The files of the build that can be in a stack:
 * - the two bundles `scripts/build.mjs` writes, `dist/main/main.cjs` and `dist/preload/main.cjs`,
 *   which a packaged app runs from inside `resources/app.asar`. They are kept as that place in
 *   the archive, whatever folder the archive is in, and however the SDK had already rewritten it
 *   (`app:///dist/main/main.cjs`, `normalizePathsIntegration`);
 * - Node's and Electron's own modules, which Node names `node:` and a lower-case path
 *   (`node:internal/process/task_queues`, `node:electron/js2c/browser_init`);
 * - the scripts of the pages the window draws, which are the web app's build: Vite's
 *   `/assets/<name>-<hash>.js` (`apps/web/src/data/allowed.ts`);
 * - the two names an engine gives code that has no file.
 */
export const FILES: ReadonlyArray<Allowed> = [
  [/^(?:.*\/)?app\.asar\/dist\/(main|preload)\/main\.cjs$/su, 'dist/$1/main.cjs'],
  [/^\/?dist\/(main|preload)\/main\.cjs$/u, 'dist/$1/main.cjs'],
  [/^(node:[a-z0-9_/.-]{1,100})$/u, '$1'],
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
 * Where a page or a request can be. The pages are the web app's route table (`parseRoute` and
 * `pathOf` in `apps/web/src/data/route.ts`), with the id each one carries replaced; the requests are `API`.
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

/** What Electron calls a process that is not the main one (`Details.type` of `child-process-gone`, electron.d.ts), and the SDK's word for a window's. */
const PROCESSES = [
  'renderer',
  'Utility',
  'Zygote',
  'Sandbox helper',
  'GPU',
  'Pepper Plugin',
  'Pepper Plugin Broker',
  'Unknown',
]

/** Why Electron says a process ended (`RenderProcessGoneDetails.reason`, electron.d.ts). */
const REASONS = [
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
]

/**
 * The one sentence the SDK writes itself, for a report that is nothing but that sentence: a
 * window or helper process that ended (`getMessageAndSeverity` in `@sentry/electron`
 * `main/integrations/child-process.js`). It is kept only when both of its blanks are Electron's
 * own words, and it is written out again from those two words, not copied.
 */
export const MESSAGES: ReadonlyArray<Allowed> = [
  [
    new RegExp(`^'(${PROCESSES.join('|')})' process exited with '(${REASONS.join('|')})'$`, 'u'),
    "'$1' process exited with '$2'",
  ],
]

/**
 * The SDK integrations this app runs, by the names the SDK gives them. In the main process: the
 * defaults of `@sentry/electron` 8.0.0 (`getDefaultIntegrations` in its `main/sdk.js`, with the
 * names each integration's own file gives it, and the Node ones from `@sentry/node`), less
 * `SentryMinidump` and `MainProcessSession`, which `options.ts` leaves out. In the window: the
 * web app's (`apps/web/src/data/allowed.ts`), whose reports pass through here.
 */
export const INTEGRATIONS: ReadonlySet<string> = new Set([
  'ElectronBreadcrumbs',
  'ElectronNet',
  'ElectronContext',
  'ChildProcess',
  'OnUncaughtException',
  'PreloadInjection',
  'AdditionalContext',
  'Screenshots',
  'GpuContext',
  'NormalizePaths',
  'EventFilters',
  'FunctionToString',
  'LinkedErrors',
  'Console',
  'NodeFetch',
  'OnUnhandledRejection',
  'ContextLines',
  'LocalVariables',
  'LocalVariablesAsync',
  'Context',
  'ConversationId',
  'BrowserApiErrors',
  'Breadcrumbs',
  'GlobalHandlers',
  'Dedupe',
  'HttpContext',
  'ScopeToMain',
])

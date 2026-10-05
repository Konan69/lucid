/**
 * The closed sets that are the phone app's own, for `scrub.ts`: the files its build makes, its
 * screens, and the SDK integrations it turns on. A path, an address or a name in an error report
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
 * The files of the build that can be in a stack. The app's JavaScript is one Hermes bundle, and
 * the SDK already names it one of two ways whatever file it was loaded from, an over-the-air
 * update included (`createReactNativeRewriteFrames` in `@sentry/react-native`
 * `integrations/rewriteframes.js`: `app:///main.jsbundle` on an iPhone, `app:///index.android.bundle`
 * on Android, and `InternalBytecode.js` for Hermes' own code). Then the names an engine gives
 * code that has no file.
 */
export const FILES: ReadonlyArray<Allowed> = [
  [/^\/?(main\.jsbundle|index\.android\.bundle|InternalBytecode\.js)$/u, 'app:///$1'],
  [/^<anonymous>$/u, '<anonymous>'],
  [/^\[native code\]$/u, '[native code]'],
  [/^native$/u, 'native'],
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
 * The app's screens, by the names its two navigators give them (`Stack.Screen` in `src/App.tsx`
 * and `src/screen/Door.tsx`). A screen's name is all a move between screens is kept as: what it
 * was opened on (which Thread, which Project) is a parameter and is never read.
 */
const SCREENS = [
  'Home',
  'Chat',
  'Computer',
  'Routines',
  'Library',
  'Folder',
  'Projects',
  'Project',
  'Settings',
  'People',
  'Memory',
  'Texting',
  'Notifications',
  'Address',
  'Welcome',
  'Email',
  'Password',
  'Create',
  'Code',
  'Google',
]

/** Where a move or a request can be: one of `SCREENS`, or one of the server's `API` parts. */
export const PLACES: ReadonlyArray<Allowed> = [
  [new RegExp(`^(${SCREENS.join('|')})$`, 'u'), '$1'],
  [/^\/health\/?$/u, '/health'],
  [new RegExp(`^/api/(${API.join('|')})(?:/.*)?$`, 'su'), '/api/$1'],
]

/** The sentences an SDK writes that may be a report's message. None is kept from the phone. */
export const MESSAGES: ReadonlyArray<Allowed> = []

/**
 * The SDK integrations this app runs, by the names the SDK gives them: what
 * `getDefaultIntegrations` of `@sentry/react-native` 8.29.0 pushes for the options in
 * `options.ts` (its `integrations/default.js`, each name from the integration's own file), less
 * the ones `options.ts` leaves out.
 */
export const INTEGRATIONS: ReadonlySet<string> = new Set([
  'ReactNativeErrorHandlers',
  'NativeLinkedErrors',
  'EventFilters',
  'FunctionToString',
  'Breadcrumbs',
  'Dedupe',
  'HttpContext',
  'Release',
  'EventOrigin',
  'SdkInfo',
  'ReactNativeInfo',
  'RewriteFrames',
  'DebugMeta',
  'DeviceContext',
  'ModulesLoader',
  'ExpoConstants',
  'PrimitiveTagIntegration',
])

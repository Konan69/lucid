import { flow, Option, Schema } from 'effect'

/**
 * The words of the address that are Vivid's own and not a place: what rides after the `?`.
 *
 * The places themselves (`/`, `/t/$id`, `/projects`, …) are the route tree (`vite.config.ts`
 * names them, `src/routes` defines them, `src/router.ts` is the router). This module has no
 * import of that tree, so the route files and the data modules can both read it.
 */

/** The Settings overlay's sections. Which one is open rides in the query so it can be linked to. */
export const SettingsSection = Schema.Literals([
  'general',
  'people',
  'connections',
  'rules',
  'memory',
  'texting',
  'devices',
  'record',
  'work',
] as const)
export type SettingsSection = typeof SettingsSection.Type

/**
 * What the app reads from the query. `settings` is absent when the overlay is shut: that is the
 * address having no such word, not a value standing in for one. Every other word in a query
 * (a sign-in's `joined`, an error code) belongs to whoever put it there and is left out.
 */
export const Search = Schema.Struct({ settings: Schema.optional(SettingsSection) })
export type Search = typeof Search.Type

/**
 * Reads the query, for the one place that takes it in (`validateSearch` on the root route).
 *
 * This is the query's ingress, so what it is handed stays opaque until the schema has read it:
 * the reader is the schema's own decoder followed by the answer for a query it refuses, and no
 * step in between names a type for the raw value. The router calls it with the parsed query and
 * nothing else (installed `@tanstack/router-core` `src/router.ts` `validateSearch`:
 * `validateSearch(input)`), and takes what it returns as the route's search
 * (`src/validators.ts` `ResolveValidatorOutputFn`).
 *
 * A section this build does not know is read as the overlay shut and not as an error page: a
 * link from a newer build still opens the app. It is answered with `settings` set to nothing and
 * not with the key left out, because the router lays what comes back over the raw query
 * (installed `@tanstack/router-core` `src/router.ts`, where a match's search is made:
 * `{ ...parentSearch, ...strictSearch }`): leaving the key out would leave the unknown word in
 * place and open Settings on a section that does not exist.
 */
export const readSearch = flow(
  Schema.decodeUnknownOption(Search),
  Option.getOrElse((): Search => ({ settings: undefined })),
)

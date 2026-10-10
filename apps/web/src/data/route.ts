import { Schema } from 'effect'

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
 * Reads the query, for the one place that takes it in (`validateSearch` on the root route). A
 * section this build does not know decodes to nothing, which the route reads as the overlay
 * shut and not as an error page: a link from a newer build still opens the app.
 */
export const decodeSearch = Schema.decodeUnknownOption(Search)

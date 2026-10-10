import { createRootRoute, Navigate } from '@tanstack/react-router'
import { Option } from 'effect'
import { decodeSearch, type Search } from '../data/route'
import { warm } from '../data/warm'

/**
 * The root of every address: who is signed in and the shell around wherever they are (`App`).
 *
 * The route files import no screen. The data modules import the router to go somewhere and the
 * router imports this tree, so a tree that imported the screens would close that circle through
 * every module a screen reads. A screen reaches its route one of two ways instead:
 *
 * - The screens a Person meets first (this shell, the first screen, a Thread, an invitation) are
 *   given to their routes by `main.tsx`, which imports them, so they ship in the app's first
 *   file. Naming them here through `import()` was measured: it cut the first load into 62 files
 *   where there had been 32.
 * - Routines, the Library and Projects are named by their routes through `lazyRouteComponent`,
 *   each in its own file, fetched on intent and when the browser is idle (`App.tsx`).
 *
 * Ported from T3 Code web (`apps/web/src/routes/__root.tsx`, `src/router.ts`): file routes, no
 * loaders that fetch, data in atoms. Adapted: T3 lets the plugin split every route's component
 * (`autoCodeSplitting`), which costs one more request before the first screen.
 */
export const Route = createRootRoute({
  // The query is read once, here; every screen gets `Search` and never the raw string.
  // What comes back is laid over the raw query by the router, so a section this build does not
  // know has to be answered with `settings` set to nothing; leaving the key out would leave the
  // unknown word in place and open Settings on a section that does not exist.
  validateSearch: (query): Search =>
    Option.getOrElse(decodeSearch(query), (): Search => ({ settings: undefined })),
  // Settings opening is the query gaining its word. The loader runs again when that changes, and
  // begins every section's data before the overlay is drawn (`data/warm.ts`); it holds nothing
  // back. Moving between sections with Settings open begins nothing twice: a query that is
  // already open is only read.
  loaderDeps: ({ search }) => ({ open: search.settings !== undefined }),
  loader: ({ deps }) => {
    if (deps.open) warm.settings()
  },
  // An address nobody recognises is the first screen, not an error page, and the address bar is
  // corrected so a reload or a shared link does not carry the wrong one on.
  notFoundComponent: () => <Navigate to="/" replace />,
})

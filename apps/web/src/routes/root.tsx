import { createRootRoute, Navigate } from '@tanstack/react-router'
import { readSearch } from '../data/route'
import { warm } from '../data/warm'

/**
 * The root of every address: who is signed in and the shell around wherever they are (`App`).
 *
 * The route files import no screen. The data modules import the router to go somewhere and the
 * router imports this tree, so a tree that imported the screens would close that circle through
 * every module a screen reads. `main.tsx` gives every route its screen instead, and nothing is
 * split off: a deploy replaces every chunk, and a tab opened before it then failed to fetch a
 * screen it had not drawn yet ("Failed to fetch dynamically imported module").
 *
 * Ported from T3 Code web (`apps/web/src/routes/__root.tsx`, `src/router.ts`): file routes, no
 * loaders that fetch, data in atoms. Adapted: T3 lets the plugin split every route's component
 * (`autoCodeSplitting`), which costs one more request before the first screen.
 */
export const Route = createRootRoute({
  // The query is read once, here; every screen gets `Search` and never the raw string. A section
  // this build does not know is read as Settings shut (`data/route.ts` `readSearch`).
  validateSearch: readSearch,
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

/**
 * Which screens the drawer stands beside, decided from the stack alone.
 *
 * Home and a Thread are the two screens a Person meets Vivid on, and they are peers: the drawer
 * lists every Thread, and Home is the Thread that has not been started. So a Thread opened
 * straight from Home is beside it, not under it. Its bar leads with the way to the drawer, as
 * Home's does, and choosing another Thread there swaps it in place.
 *
 * A Thread opened from somewhere else (a notification, a Project's page, a Routine) is under that
 * place: its bar leads with the system's way back, which returns there. The reference makes the
 * same split (T3 Code mobile `src/features/threads/ThreadRouteScreen.tsx`,
 * `unstable_headerLeftItems`: the native back button when a previous route exists, its own item
 * when there is none); Vivid's version of "none" is "only Home".
 */

/** A screen as the stack lists it. Only its name decides anything here. */
interface Placed {
  readonly name: string
}

/** What a screen's bar holds at its leading edge: the way to the drawer, or the way back. */
export type Lead = 'drawer' | 'back'

/** What leads the bar of the screen at one place in the stack. */
export const leadOf = (routes: ReadonlyArray<Placed>, at: number): Lead => {
  const here = routes[at]
  if (here === undefined) return 'back'
  if (here.name === 'Home') return 'drawer'
  const under = routes[at - 1]
  return here.name === 'Chat' && under !== undefined && under.name === 'Home' ? 'drawer' : 'back'
}

/**
 * Where a drag can open the drawer while one screen is in front.
 * - `anywhere`: Home, which has nothing a sideways drag could mean instead.
 * - `edge`: a Thread beside Home. Its tables and picture strips scroll sideways, so only a drag
 *   that starts at the leading edge of the screen is the drawer's.
 * - `none`: every other screen. The drawer is not beside it, and its edge is the way back.
 */
export type Reach = 'anywhere' | 'edge' | 'none'

/** Where the drawer can be dragged open from, for the screen at one place in the stack. */
export const reachOf = (routes: ReadonlyArray<Placed>, at: number): Reach => {
  const here = routes[at]
  if (here === undefined || leadOf(routes, at) === 'back') return 'none'
  return here.name === 'Home' ? 'anywhere' : 'edge'
}

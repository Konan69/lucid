import { Option } from 'effect'
import type { ComposerEditorHandle } from '../native/composer/types'

/**
 * Starting a new Thread from outside Home: the drawer's "New thread" (`screen/Side.tsx`).
 *
 * A new Thread is Home, and what the Person wants there is its composer with the keyboard up. But
 * the drawer can be opened from a Thread, where Home is under another screen: the stack has taken
 * its views out of the window, and a field that is not in the window cannot take the keyboard, on
 * either platform. So the wish is kept here and granted when Home says it is back in view (its
 * `transitionEnd` in `App.tsx`). With Home already in front it is granted at once.
 *
 * It is held outside React, as the drawer's own state is (`data/drawer.ts`): there is one Home
 * and one drawer, and the two are in different parts of the tree. What is held belongs to the
 * composer that is mounted, and ends with it.
 */

/** Home's composer, for as long as Home has one. A first arrival has none (`screen/Home.tsx`). */
let composer: Option.Option<ComposerEditorHandle> = Option.none()

/** Whether a new Thread was asked for while Home was covered, and Home has not come back yet. */
let wanted = false

/**
 * A ref for Home's composer. While that composer is mounted it is the one a new Thread is written
 * in. React calls the returned cleanup when it goes away (the Person signed out, or another
 * workspace's stack replaced this one), and a wish that was still waiting goes with it: it was
 * for that Home, and must not open the keyboard on whichever Home is drawn next.
 */
export const homeComposer = (handle: ComposerEditorHandle | null): (() => void) => {
  composer = Option.fromNullOr(handle)
  return () => {
    composer = Option.none()
    wanted = false
  }
}

const write = () => {
  if (Option.isSome(composer)) composer.value.focus()
}

/** The Person asked for a new Thread. `shown` is whether Home is the screen in front right now. */
export function writeAfresh(shown: boolean) {
  if (shown) {
    write()
    return
  }
  wanted = true
}

/** Home has finished coming back into view. */
export function homeShown() {
  if (!wanted) return
  wanted = false
  write()
}

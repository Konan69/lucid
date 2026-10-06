import { useSyncExternalStore } from 'react'
import { Image } from 'react-native'
import menuMark from '../../assets/menu.png'

/**
 * Whether the menu button's own picture can be drawn on this device (`assets/menu.png`, the mark
 * of `ui/Bar.tsx`). Until it is known to load, the button shows the system's own three-line
 * symbol, so the way to the menu is never a blank button.
 *
 * The picture is a file. In an installed app it comes with the binary or with an over-the-air
 * update, and the bar's button is drawn by the system from whatever the image loader hands it; a
 * file that did not arrive, or that the loader cannot read, would leave the button empty, with
 * nothing in JavaScript to notice. So the same loader is asked for the picture's size once, at
 * load: an answer means the file is there and readable, and only then is it used. A build that
 * was repacked with a new bundle and no new files (the Android emulator proof of 6 October 2026)
 * showed exactly that empty button, which is why this is checked and not assumed.
 */
let drawable = false
const listeners = new Set<() => void>()

Image.getSize(
  Image.resolveAssetSource(menuMark).uri,
  () => {
    drawable = true
    for (const listener of listeners) listener()
  },
  // No answer is the fallback's case: the button keeps the system's symbol.
  () => undefined,
)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const isDrawable = () => drawable

/** Whether the menu's own mark can be drawn. It turns true once and never back. */
export const useMenuMark = (): boolean => useSyncExternalStore(subscribe, isDrawable, isDrawable)

export { menuMark }

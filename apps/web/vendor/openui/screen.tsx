import { defineComponent } from '@openuidev/react-lang'
import { Monitor } from 'lucide-react'
import { createContext, useContext, type ComponentType } from 'react'
import { z } from 'zod/v4'

/** A screen glyph in the middle of the frame: the machine with no live picture to show. */
export function Resting() {
  return (
    <span className="vivid-screen-resting">
      <Monitor aria-hidden size={20} strokeWidth={1.6} />
    </span>
  )
}

/**
 * What draws the Computer's screen inside a `Screen` part. The surface that renders displays
 * provides it (`src/parts/Display.tsx` gives the live picture, `src/screen/computer/Glimpse.tsx`). The library
 * itself never imports the live picture: OpenUI's spec command loads `library.ts` in Node to write
 * `parts.json`, where a screen client and the browser it needs do not exist. Without a provider the
 * frame shows the resting glyph.
 */
export const ScreenPicture = createContext<ComponentType>(Resting)

/**
 * Vivid's Computer's screen on a card: the picture of the machine the 13 October Feed opens a card
 * with when the work happened there. It is the screen as it is now, not as it was when the card
 * was written: a card shows where Vivid's machine stands, and `alt` says what the Person should
 * look for on it. Watch-only; it takes no pointer.
 */
export const Screen = defineComponent({
  name: 'Screen',
  props: z.object({ alt: z.string() }),
  description:
    "Your Computer's screen as it is now, live and watch-only, for work you did on it; alt says what is on it.",
  component: function Framed({ props }) {
    const Picture = useContext(ScreenPicture)
    return (
      <div className="vivid-screen" role="img" aria-label={props.alt}>
        <Picture />
      </div>
    )
  },
})

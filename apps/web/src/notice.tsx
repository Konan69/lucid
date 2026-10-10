import { RegistryContext } from '@effect/atom-react'
import { NoticeState, type VividNoticeBridge } from '@vivid/desktop/notice'
import { Option } from 'effect'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { engine } from './data/runtime'
import { useAppearance } from './data/vivid'
import { Button } from './ui/button'
import { Face } from './ui/Face'
import { Kbd } from './ui/kbd'
import '@fontsource-variable/geist'
import '@fontsource-variable/bricolage-grotesque'
import './styles/index.css'
import './styles/notice.css'

/**
 * The notice: "Vivid is using Notepad", on the Person's screen for as long as Vivid works in
 * their apps, with the two ways to stop it.
 *
 * It is a document of its own (`notice.html`) in a small window the desktop app keeps on top of
 * everything (`apps/desktop/src/main/notice.ts`). It is Vivid's, not a system banner: the face is
 * the app's own `Face` in the look the Person chose, it is called what the Person called it, and
 * the surface is the app's `glass` and `lift` on the tokens' card radius. There is nothing behind the
 * window for the glass to blur (the desktop is another program's pixels), so here the material
 * is its tint and its edge; that is the same rule the utility already applies where blur is not
 * available.
 *
 * Nothing in it moves on its own. It arrives once, with the app's entrance, and then stands
 * still: a notice that pulsed would repaint for the whole time Vivid works, on a window that is
 * always on top.
 *
 * It learns what to say from the desktop app and can do one thing, Stop. The name and the face
 * come from the same live appearance as everywhere else (`data/vivid`).
 */

declare global {
  /** Put on the window by the notice's own preload. This document is opened by nothing else. */
  var vividNotice: VividNoticeBridge
}

const bridge = 'vividNotice' in globalThis ? Option.some(globalThis.vividNotice) : Option.none()

/**
 * What the desktop app last said the notice shows. A Zustand store, as T3 Code web keeps its
 * interface state (`apps/web/src/rightPanelStore.ts`).
 */
const useNotice = create<{ readonly shown: NoticeState }>()(() => ({
  shown: NoticeState.cases.Hidden.make({}),
}))
// Listened to for the life of the document, like the app's own stores: the window is one notice.
Option.map(bridge, (available) => available.watch((shown) => useNotice.setState({ shown })))

// The app window owns the theme and keeps it in this origin's storage; a change there reaches
// this document as a storage event, so the notice turns light or dark with the app.
addEventListener('storage', (event) => {
  if (event.key === 'vivid-theme' && event.newValue !== null)
    document.documentElement.dataset.theme = event.newValue
})

/**
 * What Vivid is doing, after its name: the whole sentence reads "Vivid is using Notepad". Hidden
 * has nothing to say, and nothing is drawn for it.
 */
const doing = (shown: NoticeState): Option.Option<string> =>
  NoticeState.match(shown, {
    Hidden: () => Option.none(),
    Working: () => Option.some('is using your computer'),
    WorkingIn: ({ app }) => Option.some(`is using ${app}`),
    Stopping: () => Option.some('is stopping'),
  })

function Notice() {
  const shown = useNotice((state) => state.shown)
  const vivid = useAppearance()
  // The window is off the screen while hidden; drawing nothing means the next turn's notice is
  // a new element, which is what makes it arrive again.
  const sentence = doing(shown)
  if (Option.isNone(sentence)) return null
  const stopping = NoticeState.guards.Stopping(shown)
  return (
    <div className="flex h-full items-start justify-center px-6 pt-3">
      {/* The card is the handle: it can be dragged anywhere for the rest of this turn. Its
          corners are the button's corner plus the 8px between them, so the curves share a
          centre. It is a card with Vivid's face, not a pill. */}
      <div className="flex h-11 max-w-full min-w-0 items-center gap-2.5 rounded-card px-2 lift glass window-drag motion-safe:animate-rise-in">
        <Face size={28} mood={stopping ? 'neutral' : 'thinking'} />
        <p role="status" className="min-w-0 truncate text-label text-ink-2">
          <span className="font-title text-ink">{vivid.name}</span> {sentence.value}
        </p>
        {/* Held out of the drag region, or a press on Stop would start moving the window. */}
        <div className="flex shrink-0 items-center gap-2 pl-1 window-hold">
          {/* Escape works from any app, without touching this window: the helper listens for it. */}
          <Kbd aria-label="Press Escape to stop">Esc</Kbd>
          <Button
            size="sm"
            variant="outline"
            disabled={stopping}
            onClick={() => Option.map(bridge, (available) => available.stop())}
          >
            Stop
          </Button>
        </div>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('The Vivid root element is missing')

createRoot(root).render(
  <StrictMode>
    <RegistryContext.Provider value={engine.registry}>
      <Notice />
    </RegistryContext.Provider>
  </StrictMode>,
)

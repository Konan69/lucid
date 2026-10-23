import { Tabs } from '@base-ui/react/tabs'
import type { ReactNode } from 'react'
import { cn } from '../../ui/cn'
import { Shelf } from './Shelf'

/**
 * A tab: a word, and a soft filled pill at the control radius (10) while it is chosen. The others
 * are plain muted words that answer to the pointer with a lighter wash and to the keyboard with
 * the app's own focus outline (`styles/index.css`, `:focus-visible`). Only the colours ease, at
 * the fast step.
 */
const TAB =
  'inline-flex h-8 cursor-pointer items-center rounded-control px-3 text-title font-title whitespace-nowrap text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink data-active:bg-wash-selected data-active:text-ink data-active:hover:bg-wash-selected'

/**
 * A panel can be reached by Tab (Base UI makes it a stop so its words can be read from the
 * keyboard) and shows the app's focus outline then; the radius is the outline's corner.
 */
const PANEL = 'rounded-row'

/**
 * The three tabs under Vivid's identity, ported from the reference (Grok Bot desktop app, the
 * card beside the conversation, screenshots of 5 Oct 2026): "Details", "Library" and "Computer"
 * as text, centred in a row; the chosen one a soft filled pill, the others plain muted words.
 *
 * Base UI's `Tabs` provides one tab stop, arrow-key navigation along the row, and panels named
 * by their tabs. The screen draws the text-and-pill treatment to match the identity card.
 *
 * The choice is the component's own state, so it lasts as long as the card is open and starts at
 * Details each time it opens. Only the chosen panel is in the document, so the Library and the
 * machine's screen are watched only while their tab is the one in view.
 *
 * A change of tab is an instant swap: it is done often and from the keyboard, and a sliding pill
 * or a fading panel would only be in the way.
 *
 * What a place puts in Details and in Computer is its own (a Thread has activity and a panel to
 * open, Home has neither); the Library tab is the same everywhere.
 */
export function Sides({
  details,
  computer,
  onClose,
}: {
  details: ReactNode
  computer: ReactNode
  onClose: () => void
}) {
  return (
    <Tabs.Root defaultValue="details" className="flex flex-col gap-5">
      <Tabs.List aria-label="Around Vivid" className="flex items-center justify-center gap-1">
        <Tabs.Tab value="details" className={TAB}>
          Details
        </Tabs.Tab>
        <Tabs.Tab value="library" className={TAB}>
          Library
        </Tabs.Tab>
        <Tabs.Tab value="computer" className={TAB}>
          Computer
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="details" className={cn(PANEL, 'space-y-6')}>
        {details}
      </Tabs.Panel>
      <Tabs.Panel value="library" className={PANEL}>
        <Shelf onClose={onClose} />
      </Tabs.Panel>
      <Tabs.Panel value="computer" className={PANEL}>
        {computer}
      </Tabs.Panel>
    </Tabs.Root>
  )
}

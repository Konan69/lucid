import type { LibraryItem } from '@vivid/contracts'
import { library, makeWhen, thisReader } from '@vivid/state'
import { Array as Arr, Order } from 'effect'
import { FileText } from 'lucide-react'
import { useState } from 'react'
import { live, LiveState, useLive } from '../../data/live'
import { router } from '../../router'
import { engine } from '../../data/runtime'
import { SkeletonList } from '../../ui/skeleton'
import { Fact, Refused, TextButton } from './Rows'

/** How many Library items the card lists before the rest are left to the Library. */
const LISTED = 4

const when = makeWhen(thisReader())

/**
 * The Person's own shelf, the one that follows them into every workspace. It is the query the
 * Library screen opens on (`screen/Library.tsx`, `live.library`), so it is shared with that
 * screen and already warm for anyone who has been there; the card asks the server nothing new.
 */
const mine = live.library.get('Mine')

/** The newest first: what was last added or changed is what a Person is most likely looking for. */
const newestFirst = Order.mapInput(Order.flip(Order.Number), (item: LibraryItem) => item.updatedAt)

/** The few the card lists. `Arr.sort` is stable, so items changed together keep the shelf's order. */
const newest = (items: ReadonlyArray<LibraryItem>) => Arr.take(Arr.sort(items, newestFirst), LISTED)

/**
 * The card's Library tab (Grok Bot desktop app, the "Library" tab beside "Details" and
 * "Computer", screenshots of 5 Oct 2026; its contents were not in the screenshots, so what it
 * lists is Vivid's own): the last few things the Person put in their Library, and the way to all
 * of it.
 *
 * The lines are facts and not rows. The Library has no address for one item, so a line could only
 * open the Library itself; the one thing here that goes anywhere says so in its own words.
 */
export function Shelf({ onClose }: { onClose: () => void }) {
  const state = useLive(mine)
  // "Now" for the times below is when the tab opened; it is not open long enough to drift.
  const [opened] = useState(() => Date.now())
  const toLibrary = () => {
    onClose()
    void router.navigate({ to: '/library' })
  }
  return LiveState.$match(state, {
    Loading: () => <SkeletonList of="row" count={2} />,
    Failed: () => (
      <Refused onRetry={() => engine.registry.refresh(mine.atom)}>
        Your Library can’t be reached right now.
      </Refused>
    ),
    Ready: ({ value }) => {
      const items = newest(value.documents)
      return (
        <>
          {items.length === 0 && (
            <p className="py-1.5 text-label font-meta text-pretty text-ink-3">
              Nothing in your Library yet. Vivid can read anything you add there in every thread.
            </p>
          )}
          <ul className="empty:hidden">
            {items.map((item) => (
              <li key={item.id}>
                <Fact
                  entry={{
                    icon: <FileText className="size-4" />,
                    title: item.name,
                    detail: `${library.formatBytes(item.size)} · ${when(item.updatedAt, opened)}`,
                    lit: false,
                  }}
                />
              </li>
            ))}
          </ul>
          <div className="mt-1 text-label">
            <TextButton onClick={toLibrary}>
              {items.length === 0 ? 'Open the Library' : 'See all'}
            </TextButton>
          </div>
        </>
      )
    },
  })
}

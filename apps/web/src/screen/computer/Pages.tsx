import { PageLoadFailure, type Page } from '@vivid/desktop/bridge'
import { Option } from 'effect'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { pages, type Front } from '../../data/pages'
import { Button, IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Face } from '../../ui/Face'

/**
 * The pages open inside Vivid, in the desktop app: their tabs, the row that says where one is and
 * takes it somewhere else, and the place the page itself is drawn. The page is not part of this
 * document. It is a browser view the desktop app owns and lays over a rectangle this panel
 * reports, so nothing a page does can reach the app around it. The pattern is T3 Code's preview
 * browser.
 */

/** One tab, as wide as its title up to a point, like the computer's tab beside it. */
const TAB =
  'group/tab flex h-8 max-w-44 min-w-0 cursor-pointer items-center gap-2 rounded-control pr-1.5 pl-2.5 text-label transition-colors duration-(--dur-fast)'

/** A page's name on its tab: its title, or where it is while it has none. */
const nameOf = (page: Page) => (page.title.trim().length > 0 ? page.title : page.address)

/** The open pages as tabs, and the way to open another. */
export function PageTabs({
  open,
  front,
  showing,
}: {
  open: ReadonlyArray<Page>
  front: Front
  showing: Option.Option<Page>
}) {
  return (
    <>
      {open.map((page) => {
        const active = front === 'page' && Option.exists(showing, (shown) => shown.tab === page.tab)
        return (
          <span
            key={page.tab}
            className={cn(
              TAB,
              active
                ? 'bg-surface-3 font-title text-ink smooth-shadow-ring-xs'
                : 'text-ink-3 hover:bg-wash-hover hover:text-ink',
            )}
          >
            <button
              onClick={() => pages.show(page.tab)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 outline-none"
            >
              <Globe
                className={cn('size-4 shrink-0 text-ink-3', page.loading && 'animate-status-pulse')}
              />
              <span className="truncate">{nameOf(page)}</span>
            </button>
            <button
              aria-label={`Close ${nameOf(page)}`}
              onClick={() => pages.close(page.tab)}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs text-ink-4 hover:bg-wash-pressed hover:text-ink"
            >
              <X className="size-3" />
            </button>
          </span>
        )
      })}
      <IconButton label="Open a page" active={front === 'new'} onClick={pages.toNew}>
        <Plus className="size-4" />
      </IconButton>
    </>
  )
}

/** Back, forward, reload, and where the page is. Typing somewhere new and Enter goes there. */
export function PageToolbar({ page }: { page: Option.Option<Page> }) {
  const tab = Option.map(page, (shown) => shown.tab)
  return (
    <>
      <IconButton
        label="Back"
        disabled={!Option.exists(page, (shown) => shown.canGoBack)}
        onClick={() => Option.map(tab, pages.back)}
      >
        <ArrowLeft className="size-4" />
      </IconButton>
      <IconButton
        label="Forward"
        disabled={!Option.exists(page, (shown) => shown.canGoForward)}
        onClick={() => Option.map(tab, pages.forward)}
      >
        <ArrowRight className="size-4" />
      </IconButton>
      <IconButton
        label={Option.exists(page, (shown) => shown.loading) ? 'Stop loading' : 'Load it again'}
        disabled={Option.isNone(page)}
        onClick={() =>
          Option.map(page, (shown) =>
            shown.loading ? pages.stop(shown.tab) : pages.reload(shown.tab),
          )
        }
      >
        {Option.exists(page, (shown) => shown.loading) ? (
          <X className="size-4" />
        ) : (
          <RotateCw className="size-4" />
        )}
      </IconButton>
      <Address
        // The field follows the page: a navigation, or another tab, starts it from what is true.
        key={Option.match(page, {
          onNone: () => 'new',
          onSome: (shown) => `${shown.tab}:${shown.address}`,
        })}
        page={page}
      />
    </>
  )
}

/**
 * The long field. At rest it says where the page is; while someone is typing it holds what they
 * typed. Enter goes there (words that are not an address become a search); Escape puts back what
 * is true.
 */
function Address({ page }: { page: Option.Option<Page> }) {
  const here = Option.match(page, { onNone: () => '', onSome: (shown) => shown.address })
  const [typed, setTyped] = useState(here)
  return (
    <form
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault()
        const address = typed.trim()
        if (address.length === 0) return
        Option.match(page, {
          onNone: () => pages.open(address),
          onSome: (shown) => pages.go(shown.tab, address),
        })
      }}
    >
      <input
        value={typed}
        // A page not opened yet has nothing to show but this field, so the keyboard starts in it.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={Option.isNone(page)}
        onChange={(event) => setTyped(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setTyped(here)
        }}
        aria-label="Address"
        placeholder="Search or enter an address"
        spellCheck={false}
        autoComplete="off"
        className="h-9 w-full rounded-full bg-well px-4 text-center text-label text-ink outline-none placeholder:text-ink-3 focus:text-left focus-visible:ring-2 focus-visible:ring-ring"
      />
    </form>
  )
}

/** Whether something modal is over the app: a page drawn by the desktop app would sit on top of it. */
const covered = () => document.querySelector('[aria-modal="true"]') !== null

/**
 * Where the showing page is drawn. This element is empty: it reports its own rectangle to the
 * desktop app, which lays the page over it, and reports again whenever that rectangle changes (the
 * panel is widened, the window resized) or something modal opens over the app, when the page is
 * taken off the window until it closes. Leaving takes the page off too.
 */
export function PageView({ page }: { page: Option.Option<Page> }) {
  const place = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return undefined
    const report = () => {
      const box = element.getBoundingClientRect()
      pages.place(
        covered() || box.width === 0 || box.height === 0
          ? 'hidden'
          : { x: box.x, y: box.y, width: box.width, height: box.height },
      )
    }
    const sized = new ResizeObserver(report)
    sized.observe(element)
    // Dialogs and the palette are drawn at the end of the document, so they arrive as children.
    const layered = new MutationObserver(report)
    layered.observe(document.body, { childList: true })
    addEventListener('resize', report)
    report()
    return () => {
      sized.disconnect()
      layered.disconnect()
      removeEventListener('resize', report)
      pages.place('hidden')
    }
  }, [])

  if (Option.isNone(page)) {
    return (
      <Blank title="Open a page" detail="Type an address above, or a few words to search for." />
    )
  }
  return PageLoadFailure.match(page.value.failed, {
    None: () => <div ref={place} className="min-h-0 flex-1" />,
    Some: ({ value }) => (
      <Blank
        title="This page did not load"
        detail={value}
        action={<Button onClick={() => pages.reload(page.value.tab)}>Try again</Button>}
      />
    ),
  })
}

function Blank({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Face size={36} mood="neutral" />
      <h3 className="text-title font-title text-ink">{title}</h3>
      <p className="max-w-xs text-label text-ink-3">{detail}</p>
      {action}
    </div>
  )
}

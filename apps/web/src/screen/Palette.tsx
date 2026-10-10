import { SearchResult, type SearchResponse, type Thread } from '@vivid/contracts'
import { LiveState, liveStateOf } from '@vivid/state'
import { Array as Arr, Option, Order } from 'effect'
import { FileText, Search } from 'lucide-react'
import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useState, type ReactNode } from 'react'
import { shortcut } from '../data/keys'
import { findings, findQuery, live, useLiveValue } from '../data/live'
import { openSettings, router } from '../router'
import { sidebar } from '../data/sidebar'
import { cn } from '../ui/cn'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { useSurface } from '../ui/Layer'
import { Emblem } from './Emblem'
import { PlaceMark } from './Place'

type Found = SearchResponse['results'][number]

/** What a result is called, what kind of thing it is, and where choosing it goes. */
const describe = (result: Found) =>
  SearchResult.match(result, {
    Thread: ({ thread }) => ({
      key: `thread:${thread.id}`,
      title: thread.title,
      detail: thread.preview,
      icon: <PlaceMark place="thread" />,
      go: () => void router.navigate({ to: '/t/$id', params: { id: thread.id } }),
    }),
    LibraryItem: ({ item }) => ({
      key: `item:${item.id}`,
      title: item.name,
      detail: 'In the Library',
      icon: (
        // A document is a thing in the Library, so it wears the Library's hue with its own glyph.
        <Emblem hue="violet" size={24}>
          <FileText />
        </Emblem>
      ),
      go: () => void router.navigate({ to: '/library' }),
    }),
    Routine: ({ routine }) => ({
      key: `routine:${routine.id}`,
      title: routine.name,
      detail: 'Routine',
      icon: <PlaceMark place="routines" />,
      go: () => void router.navigate({ to: '/routines' }),
    }),
  })

/** One thing the palette can do or go to. */
interface Item {
  readonly key: string
  readonly title: string
  readonly detail: string
  readonly icon: ReactNode
  /** The shortcut that does the same from anywhere, when there is one. */
  readonly keys: Option.Option<string>
  readonly go: () => void
}

/** What the Person can do from anywhere, each with the other words they might type for it. */
const ACTIONS: ReadonlyArray<Item & { readonly words: string }> = [
  {
    key: 'do:new',
    title: 'New thread',
    detail: 'Ask Vivid for something',
    words: 'start chat message ask compose',
    icon: <PlaceMark place="compose" />,
    keys: Option.some(shortcut('⇧O')),
    go: () => void router.navigate({ to: '/' }),
  },
  {
    key: 'do:routines',
    title: 'Routines',
    detail: 'Work Vivid does on a schedule or when called',
    words: 'schedule recurring cron automatic',
    icon: <PlaceMark place="routines" />,
    keys: Option.none(),
    go: () => void router.navigate({ to: '/routines' }),
  },
  {
    key: 'do:projects',
    title: 'Projects',
    detail: 'Threads kept together',
    words: 'folders groups spaces',
    icon: <PlaceMark place="projects" />,
    keys: Option.none(),
    go: () => void router.navigate({ to: '/projects/{-$id}', params: { id: undefined } }),
  },
  {
    key: 'do:library',
    title: 'Library',
    detail: 'Documents Vivid can read',
    words: 'files documents uploads pdf',
    icon: <PlaceMark place="library" />,
    keys: Option.none(),
    go: () => void router.navigate({ to: '/library' }),
  },
  {
    key: 'do:connections',
    title: 'Integrations',
    detail: 'The services Vivid can use',
    words: 'connect integrations accounts gmail slack calendar',
    icon: <PlaceMark place="integrations" />,
    keys: Option.none(),
    go: () => void openSettings('connections'),
  },
  {
    key: 'do:memory',
    title: 'What Vivid knows',
    detail: 'Read, correct or remove what it has kept',
    words: 'memory remember forget brain',
    icon: <PlaceMark place="memory" />,
    keys: Option.none(),
    go: () => void openSettings('memory'),
  },
  {
    key: 'do:settings',
    title: 'Settings',
    detail: 'Appearance, time zone, notifications, people, rules',
    words: 'preferences theme dark light appearance account sign out',
    icon: <PlaceMark place="general" />,
    keys: Option.none(),
    go: () => void openSettings('general'),
  },
  {
    key: 'do:sidebar',
    title: 'Hide or show the sidebar',
    detail: 'More room for the thread',
    words: 'toggle panel rail collapse',
    icon: <PlaceMark place="sidebar" />,
    keys: Option.some(shortcut('B')),
    go: sidebar.toggle,
  },
]

/** Threads by when they last moved, newest first. */
const newestFirst = Order.mapInput(Order.flip(Order.Number), (thread: Thread) => thread.updatedAt)

/** How many recent Threads the empty palette offers. */
const RECENT = 8

/**
 * Whether every word typed appears in something's title or its other words. Order does not
 * matter and neither does case: "thread new" finds "New thread".
 */
const answersTo = (typed: string, title: string, words: string) => {
  const said = `${title} ${words}`.toLocaleLowerCase()
  return typed
    .toLocaleLowerCase()
    .split(/\s+/u)
    .every((word) => said.includes(word))
}

/** A Thread as something to go to. */
const threadItem = (thread: Thread): Item => ({
  key: `recent:${thread.id}`,
  title: thread.title,
  detail: thread.preview,
  icon: <PlaceMark place="thread" />,
  keys: Option.none(),
  go: () => void router.navigate({ to: '/t/$id', params: { id: thread.id } }),
})

/** A server result as something to go to. */
const foundItem = (result: Found): Item => {
  const described = describe(result)
  return { ...described, keys: Option.none() }
}

/** One part of the list, under its heading. */
interface Group {
  readonly heading: string
  readonly items: ReadonlyArray<Item>
}

/**
 * What the palette lists for what has been typed.
 *
 * Nothing typed: what can be done from here, then the Threads last worked in, so the palette is
 * useful before a single key is pressed. Something typed: the actions it names, then what the
 * server found. A leading ">" asks for actions only, the way it does in every editor.
 */
function groupsFor(
  typed: string,
  recent: ReadonlyArray<Thread>,
  found: ReadonlyArray<Found>,
): ReadonlyArray<Group> {
  const onlyActions = typed.startsWith('>')
  const asked = (onlyActions ? typed.slice(1) : typed).trim()
  if (asked.length === 0) {
    return [
      { heading: 'Go to', items: ACTIONS },
      ...(onlyActions ? [] : [{ heading: 'Recent', items: recent.map(threadItem) }]),
    ].filter((group) => group.items.length > 0)
  }
  return [
    {
      heading: 'Go to',
      items: ACTIONS.filter((action) => answersTo(asked, action.title, action.words)),
    },
    { heading: 'Found', items: onlyActions ? [] : found.map(foundItem) },
  ].filter((group) => group.items.length > 0)
}

/** Why the list is empty: still asking, could not ask, or truly nothing. */
const nothingSaid = (answer: LiveState<SearchResponse>) =>
  LiveState.$match(answer, {
    Loading: () => 'Searching…',
    Failed: () => 'Search could not be reached. Try again in a moment.',
    Ready: () => 'Nothing matches that.',
  })

/**
 * Find anything, do anything (⌘K). With nothing typed it lists what can be done and the Threads
 * last worked in. Typing narrows the actions and searches Threads, Tasks, Library items and
 * Routines on the server, so the answer respects exactly what the Person may see. The arrow keys
 * and Enter choose. The last answer stays up while the next is on its way.
 */
export function Palette({ onClose }: { onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const setQuery = useAtomSet(findQuery)
  const answer = liveStateOf(useAtomValue(findings))
  const threads = useLiveValue(live.threads)
  const [selectedKey, setSelectedKey] = useState('do:new')
  const recent = Option.match(threads, {
    onNone: () => [],
    onSome: (value) =>
      Arr.sort(
        value.threads.filter((thread) => !thread.archived),
        newestFirst,
      ).slice(0, RECENT),
  })
  const groups = groupsFor(
    typed,
    recent,
    LiveState.$is('Ready')(answer) ? answer.value.results : [],
  )
  const items = groups.flatMap((group) => group.items)
  const selected = items.find((item) => item.key === selectedKey) ?? items[0]
  const index = selected === undefined ? 0 : items.indexOf(selected)

  /** Keep keyboard selection in view without moving the palette's own scroll position. */
  const keepActiveVisible = useCallback((node: HTMLButtonElement | null) => {
    if (node !== null) node.scrollIntoView({ block: 'nearest' })
  }, [])

  /** Closes, and forgets what was typed: the next search starts from an empty field. */
  function close() {
    setQuery('')
    onClose()
  }

  function choose(position: number) {
    const picked = Option.fromUndefinedOr(items[position])
    if (Option.isNone(picked)) return
    close()
    picked.value.go()
  }

  return (
    // The app draws the palette only while it is wanted, so it is open from its first render.
    // Sent away (Escape, a click outside) it leaves and then forgets what was typed; choosing a
    // result closes it at once, because where that leads is what the Person wants next.
    <Dialog {...useSurface(close)}>
      {/* A fixed distance from the top and not centred: the list under the field grows and
          shrinks with every key, and a centred panel would move the field as it did. It has no
          close control: Escape is in its foot. The field has the keyboard from the first frame,
          so what is typed is never lost to the panel's arrival. */}
      <DialogContent
        showCloseButton={false}
        flush
        instant
        className="top-24 translate-y-0 overflow-hidden sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search and actions</DialogTitle>
        {/* The field, the list and the foot run edge to edge (`flush`), and the panel is there at
            once (`instant`): it is opened from the keyboard many times a day. */}
        <div>
          <label className="flex h-12 items-center gap-2.5 px-4 hairline-b">
            <Search className="size-4 text-ink-3" />
            <input
              // The palette is opened to type in; nothing else on it can take focus first.
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={typed}
              maxLength={200}
              aria-label="Search, or type what you want to do"
              onChange={(event) => {
                const next = event.currentTarget.value
                setTyped(next)
                // Actions are found here; only a search goes to the server.
                setQuery(next.startsWith('>') ? '' : next)
              }}
              // The arrows and Enter belong to the field: a result that has the keyboard through
              // Tab is activated by its own Enter, not by whichever one the arrows last marked.
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const next = Math.min(index + 1, Math.max(items.length - 1, 0))
                  const nextItem = items[next]
                  setSelectedKey(nextItem === undefined ? '' : nextItem.key)
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  const next = Math.max(index - 1, 0)
                  const nextItem = items[next]
                  setSelectedKey(nextItem === undefined ? '' : nextItem.key)
                }
                if (event.key === 'Enter') choose(index)
              }}
              placeholder="Search, or type what you want to do"
              className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <div className="max-h-112 overflow-y-auto p-1">
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-label text-ink-3" aria-live="polite">
                {nothingSaid(answer)}
              </p>
            )}
            {groups.map((group) => (
              <section key={group.heading} aria-label={group.heading}>
                <h3 className="px-3 pt-2 pb-1 text-meta font-meta text-ink-3">{group.heading}</h3>
                <ul>
                  {group.items.map((item) => {
                    const active = selected !== undefined && item.key === selected.key
                    return (
                      <Row
                        key={item.key}
                        item={item}
                        active={active}
                        activeRef={active ? keepActiveVisible : undefined}
                        onHover={() => setSelectedKey(item.key)}
                        onChoose={() => choose(items.indexOf(item))}
                      />
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
          <Foot />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** What the keyboard does here, said once at the foot where a palette always says it. */
function Foot() {
  return (
    <footer className="hidden h-9 items-center gap-4 px-4 text-meta font-meta text-ink-3 hairline-t sm:flex">
      <Hint keys="↑↓" does="Move" />
      <Hint keys="↵" does="Open" />
      <Hint keys=">" does="Actions only" />
      <span className="flex-1" />
      <Hint keys="esc" does="Close" />
    </footer>
  )
}

/** One key and what it does, in the palette's foot. */
function Hint({ keys, does }: { keys: string; does: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded-xs bg-surface-2 px-1.5 py-0.5 font-sans text-ink-2">{keys}</kbd>
      {does}
    </span>
  )
}

function Row({
  item,
  active,
  activeRef,
  onHover,
  onChoose,
}: {
  item: Item
  active: boolean
  activeRef?: (node: HTMLButtonElement | null) => void
  onHover: () => void
  onChoose: () => void
}) {
  return (
    <li>
      <button
        ref={activeRef}
        onMouseEnter={onHover}
        onClick={onChoose}
        className={cn(
          // The marked row changes at once: it follows the arrow keys, and a fill that eased
          // from row to row would trail behind them.
          'flex h-12 w-full cursor-pointer items-center gap-3 rounded-row px-2.5 text-left',
          active ? 'bg-wash-selected' : 'hover:bg-wash-hover',
        )}
      >
        {item.icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label text-ink">{item.title}</span>
          <span className="block truncate text-meta font-meta text-ink-3">{item.detail}</span>
        </span>
        {Option.isSome(item.keys) && (
          <kbd className="shrink-0 rounded-xs bg-surface-2 px-1.5 py-0.5 font-sans text-meta text-ink-3 tabular-nums">
            {item.keys.value}
          </kbd>
        )}
      </button>
    </li>
  )
}

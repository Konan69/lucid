import { SearchResult, type SearchResponse, type Thread } from '@vivid/contracts'
import { LiveState, liveStateOf } from '@vivid/state'
import { Array as Arr, Option, Order } from 'effect'
import {
  Brain,
  FileText,
  FolderKanban,
  Library as LibraryIcon,
  Link2,
  ListTodo,
  MessageSquare,
  PanelLeft,
  Repeat2,
  Search,
  SlidersHorizontal,
  SquarePen,
} from 'lucide-react'
import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useState, type ReactNode } from 'react'
import { shortcut } from '../data/keys'
import { findings, findQuery, live, useLiveValue } from '../data/live'
import { Route, router } from '../data/route'
import { sidebar } from '../data/sidebar'
import { cn } from '../ui/cn'
import { holdFocus, keepFocusInside } from '../ui/Layer'

type Found = SearchResponse['results'][number]

/** What a result is called, what kind of thing it is, and where choosing it goes. */
const describe = (result: Found) =>
  SearchResult.match(result, {
    Thread: ({ thread }) => ({
      key: `thread:${thread.id}`,
      title: thread.title,
      detail: thread.preview,
      icon: <MessageSquare className="size-4" />,
      go: () => router.go(Route.Thread({ id: thread.id })),
    }),
    Task: ({ task }) => ({
      key: `task:${task.id}`,
      title: task.title,
      detail: 'Task',
      icon: <ListTodo className="size-4" />,
      // A Task lives in the Thread it reports to; that is where it is read and changed.
      go: () => router.go(Route.Thread({ id: task.threadId })),
    }),
    LibraryItem: ({ item }) => ({
      key: `item:${item.id}`,
      title: item.name,
      detail: 'In the Library',
      icon: <FileText className="size-4" />,
      go: () => router.go(Route.Library()),
    }),
    Routine: ({ routine }) => ({
      key: `routine:${routine.id}`,
      title: routine.name,
      detail: 'Routine',
      icon: <Repeat2 className="size-4" />,
      go: () => router.go(Route.Routines()),
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
    icon: <SquarePen className="size-4" />,
    keys: Option.some(shortcut('⇧O')),
    go: () => router.go(Route.New()),
  },
  {
    key: 'do:routines',
    title: 'Routines',
    detail: 'Work Vivid does on a schedule or when called',
    words: 'schedule recurring cron automatic',
    icon: <Repeat2 className="size-4" />,
    keys: Option.none(),
    go: () => router.go(Route.Routines()),
  },
  {
    key: 'do:projects',
    title: 'Projects',
    detail: 'Threads kept together',
    words: 'folders groups spaces',
    icon: <FolderKanban className="size-4" />,
    keys: Option.none(),
    go: () => router.go(Route.Projects()),
  },
  {
    key: 'do:library',
    title: 'Library',
    detail: 'Documents Vivid can read',
    words: 'files documents uploads pdf',
    icon: <LibraryIcon className="size-4" />,
    keys: Option.none(),
    go: () => router.go(Route.Library()),
  },
  {
    key: 'do:connections',
    title: 'Connections',
    detail: 'The services Vivid can use',
    words: 'connect integrations accounts gmail slack calendar',
    icon: <Link2 className="size-4" />,
    keys: Option.none(),
    go: () => router.openSettings(Option.some('connections')),
  },
  {
    key: 'do:memory',
    title: 'What Vivid knows',
    detail: 'Read, correct or remove what it has kept',
    words: 'memory remember forget brain',
    icon: <Brain className="size-4" />,
    keys: Option.none(),
    go: () => router.openSettings(Option.some('memory')),
  },
  {
    key: 'do:settings',
    title: 'Settings',
    detail: 'Appearance, time zone, notifications, people, rules',
    words: 'preferences theme dark light appearance account sign out',
    icon: <SlidersHorizontal className="size-4" />,
    keys: Option.none(),
    go: () => router.openSettings(Option.some('general')),
  },
  {
    key: 'do:sidebar',
    title: 'Hide or show the sidebar',
    detail: 'More room for the thread',
    words: 'toggle panel rail collapse',
    icon: <PanelLeft className="size-4" />,
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
  icon: <MessageSquare className="size-4" />,
  keys: Option.none(),
  go: () => router.go(Route.Thread({ id: thread.id })),
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
    // No arrival animation, on purpose: this opens from the keyboard many times a day, and
    // anything between the keystroke and the field being ready reads as lag.
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-4 pt-24 backdrop-blur-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close()
        keepFocusInside(event)
      }}
    >
      <div
        ref={holdFocus}
        role="dialog"
        aria-modal="true"
        aria-label="Search and actions"
        tabIndex={-1}
        className="w-full max-w-xl overflow-hidden rounded-panel bg-surface-1 smooth-shadow-ring-lg outline-none"
      >
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
        <div className="max-h-96 overflow-y-auto p-1">
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
      </div>
    </div>
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
          'flex h-11 w-full cursor-pointer items-center gap-3 rounded-row px-3 text-left transition-colors duration-(--dur-fast)',
          active ? 'bg-wash-selected' : 'hover:bg-wash-hover',
        )}
      >
        <span className="shrink-0 text-ink-3">{item.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label text-ink">{item.title}</span>
          <span className="block truncate text-meta font-meta text-ink-3">{item.detail}</span>
        </span>
        {Option.isSome(item.keys) && (
          <kbd className="shrink-0 font-sans text-meta text-ink-3">{item.keys.value}</kbd>
        )}
      </button>
    </li>
  )
}

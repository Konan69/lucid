import { SearchResult, type SearchResponse } from '@vivid/contracts'
import { LiveState, liveStateOf } from '@vivid/state'
import { Option } from 'effect'
import { FileText, ListTodo, MessageSquare, Repeat2, Search } from 'lucide-react'
import { useAtom, useAtomValue } from '@effect/atom-react'
import { useState, type ReactNode } from 'react'
import { findings, findQuery } from '../data/live'
import { Route, router } from '../data/route'
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

/** Why the list is empty: nothing asked yet, still asking, could not ask, or truly nothing. */
const nothingSaid = (query: string, answer: LiveState<SearchResponse>) =>
  LiveState.$match(answer, {
    Loading: () => 'Searching…',
    Failed: () => 'Search could not be reached. Try again in a moment.',
    Ready: () => (query.trim().length === 0 ? 'Start typing to search.' : 'Nothing matches that.'),
  })

/**
 * Find anything (⌘K): Threads, Tasks, Library items and Routines the Person can see, searched on
 * the server so the answer respects exactly what they are allowed to see. Typing searches; the
 * arrow keys and Enter choose. The last answer stays up while the next is on its way.
 */
export function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useAtom(findQuery)
  const answer = liveStateOf(useAtomValue(findings))
  const [index, setIndex] = useState(0)
  const results = LiveState.$is('Ready')(answer) ? answer.value.results : []

  /** Closes, and forgets what was typed: the next search starts from an empty field. */
  function close() {
    setQuery('')
    onClose()
  }

  function choose(position: number) {
    const picked = Option.fromUndefinedOr(results[position])
    if (Option.isNone(picked)) return
    close()
    describe(picked.value).go()
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
        aria-label="Search"
        tabIndex={-1}
        className="w-full max-w-xl overflow-hidden rounded-panel bg-surface-1 smooth-shadow-ring-lg outline-none"
      >
        <label className="flex h-12 items-center gap-2.5 px-4 hairline-b">
          <Search className="size-4 text-ink-3" />
          <input
            // The palette is opened to type in; nothing else on it can take focus first.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            maxLength={200}
            aria-label="Search threads, tasks, the library and routines"
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setIndex(0)
            }}
            // The arrows and Enter belong to the field: a result that has the keyboard through
            // Tab is activated by its own Enter, not by whichever one the arrows last marked.
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex((current) => Math.max(current - 1, 0))
              }
              if (event.key === 'Enter') choose(index)
            }}
            placeholder="Search threads, tasks, the library and routines"
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <ul className="max-h-96 overflow-y-auto p-1">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-label text-ink-3" aria-live="polite">
              {nothingSaid(query, answer)}
            </li>
          )}
          {results.map((result, position) => (
            <Row
              key={describe(result).key}
              active={position === index}
              title={describe(result).title}
              detail={describe(result).detail}
              icon={describe(result).icon}
              onHover={() => setIndex(position)}
              onChoose={() => choose(position)}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

function Row({
  active,
  title,
  detail,
  icon,
  onHover,
  onChoose,
}: {
  active: boolean
  title: string
  detail: string
  icon: ReactNode
  onHover: () => void
  onChoose: () => void
}) {
  return (
    <li>
      <button
        onMouseEnter={onHover}
        onClick={onChoose}
        className={cn(
          'flex h-11 w-full cursor-pointer items-center gap-3 rounded-row px-3 text-left transition-colors duration-(--dur-fast)',
          active ? 'bg-wash-selected' : 'hover:bg-wash-hover',
        )}
      >
        <span className="shrink-0 text-ink-3">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label text-ink">{title}</span>
          <span className="block truncate text-meta font-meta text-ink-3">{detail}</span>
        </span>
      </button>
    </li>
  )
}

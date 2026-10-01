import { SearchResult, type SearchResponse } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { FileText, ListTodo, MessageSquare, Repeat2, Search } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change } from '../data/live'
import { Route, router } from '../data/route'
import { cn } from '../ui/cn'

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

/**
 * Find anything (⌘K): Threads, Tasks, Library items and Routines the Person can see, searched on
 * the server so the answer respects exactly what they are allowed to see. Typing searches; the
 * arrow keys and Enter choose; an answer that arrives for an older query is ignored.
 */
export function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{
    readonly for: string
    readonly results: ReadonlyArray<Found>
  }>({
    for: '',
    results: [],
  })
  const [index, setIndex] = useState(0)
  const results = found.for === query ? found.results : []

  async function search(text: string) {
    setQuery(text)
    setIndex(0)
    const answer = await change((client) => client.Search({ query: text }))
    if (Result.isSuccess(answer)) setFound({ for: text, results: answer.success.results })
  }

  function choose(position: number) {
    const picked = Option.fromUndefinedOr(results[position])
    if (Option.isNone(picked)) return
    onClose()
    describe(picked.value).go()
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-scrim px-4 pt-24 backdrop-blur-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="w-full max-w-xl animate-rise-in overflow-hidden rounded-panel bg-surface-1 smooth-shadow-ring-lg"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
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
      >
        <label className="flex h-12 items-center gap-2.5 px-4 hairline-b">
          <Search className="size-4 text-ink-3" />
          <input
            // The palette is opened to type in; nothing else on it can take focus first.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            onChange={(event) => void search(event.currentTarget.value)}
            onFocus={() => void search(query)}
            placeholder="Search threads, tasks, the library and routines"
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-4"
          />
        </label>
        <ul className="max-h-96 overflow-y-auto p-1">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-label text-ink-3">
              {query.trim().length === 0 ? 'Start typing to search.' : 'Nothing matches that.'}
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

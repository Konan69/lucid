import { Array as Arr, Order, Schema } from 'effect'
import { SearchResult, type Thread, type Routine, type LibraryItem } from '@vivid/contracts'

const Candidate = Schema.Struct({
  result: SearchResult,
  title: Schema.String,
  text: Schema.Array(Schema.String),
  updatedAt: Schema.Finite,
})
type Candidate = typeof Candidate.Type

/** Title and preview are searched together without creating a second Thread visibility policy. */
export const threadCandidate = (thread: Thread): Candidate =>
  Candidate.make({
    result: SearchResult.cases.Thread.make({ thread }),
    title: thread.title,
    text: [thread.title, thread.preview],
    updatedAt: thread.updatedAt,
  })
/** A Routine's prompt is searchable beside its name. */
export const routineCandidate = (routine: Routine): Candidate =>
  Candidate.make({
    result: SearchResult.cases.Routine.make({ routine }),
    title: routine.name,
    text: [routine.name, routine.prompt],
    updatedAt: routine.updatedAt,
  })
/** Library search in the palette matches document names, never folders or extracted content. */
export const itemCandidate = (item: LibraryItem): Candidate =>
  Candidate.make({
    result: SearchResult.cases.LibraryItem.make({ item }),
    title: item.name,
    text: [item.name],
    updatedAt: item.updatedAt,
  })

/** Every term must appear; complete title/name matches precede body matches, then newer records win. */
export const rankResults = (
  query: string,
  candidates: ReadonlyArray<Candidate>,
): ReadonlyArray<SearchResult> => {
  const terms = query.toLowerCase().trim().split(/\s+/u)
  const scored = candidates.map((candidate) => {
    const title = candidate.title.toLowerCase()
    const text = candidate.text.join(' ').toLowerCase()
    return {
      candidate,
      matches: terms.every((term) => text.includes(term)),
      score: terms.every((term) => title.includes(term)) ? 1 : 0,
    }
  })
  return Arr.sort(
    scored.filter((entry) => entry.matches),
    (left: (typeof scored)[number], right: (typeof scored)[number]) =>
      Order.Number(right.score, left.score) ||
      Order.Number(right.candidate.updatedAt, left.candidate.updatedAt),
  )
    .slice(0, 20)
    .map((entry) => entry.candidate.result)
}

/** The empty palette only shows the eight most recently active authorized Threads. */
export const recentThreads = (threads: ReadonlyArray<Thread>) =>
  Arr.sort(threads, (left: Thread, right: Thread) => Order.Number(right.updatedAt, left.updatedAt))
    .slice(0, 8)
    .map((thread) => SearchResult.cases.Thread.make({ thread }))

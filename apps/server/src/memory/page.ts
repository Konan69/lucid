import { MemoryNote, MemoryNoteScope, MemoryPage, MemoryScope, type Memory } from '@vivid/contracts'

/**
 * How much of what Vivid knows goes in front of the model on every response, in characters of
 * fact text. About 2,000 tokens: the size Cloudflare's Think gives its writable `memory` block
 * (`maxTokens: 2000`, developers.cloudflare.com/agents/harnesses/think/configuration). Characters
 * are counted because no tokenizer runs on this path; four characters a token is the usual ratio.
 */
export const PAGE_BUDGET = 8000

/** The newest memories the acting Person may read here, and whether the store held older ones. */
export interface PageRead {
  readonly memories: ReadonlyArray<Memory>
  readonly truncated: boolean
}

/** A Thread scope keeps its title for the model and drops its identifier. */
function noteScope(scope: MemoryScope): MemoryNoteScope {
  return MemoryScope.match(scope, {
    Person: (): MemoryNoteScope => MemoryNoteScope.cases.Person.make({}),
    Company: (): MemoryNoteScope => MemoryNoteScope.cases.Company.make({}),
    Thread: ({ title }): MemoryNoteScope => MemoryNoteScope.cases.Thread.make({ title }),
  })
}

/**
 * The page from the memories the acting Person may read here, which arrive newest first.
 *
 * Facts are taken whole, in order, until the next one would pass the budget; that one and every
 * older fact are left out. Taking in order, with no skipping ahead to a shorter fact, keeps the
 * page a clean "everything since" window, so `older` means "older than what you see". A single
 * fact longer than the whole budget is still shown: an empty page with facts stored would tell
 * the model it knows nothing.
 */
export function pageOf(read: PageRead): MemoryPage {
  let used = 0
  const fits = read.memories.findIndex((memory, index) => {
    used += memory.content.length
    return used > PAGE_BUDGET && index > 0
  })
  const shown = fits === -1 ? read.memories : read.memories.slice(0, fits)
  return MemoryPage.make({
    notes: shown.map((memory) =>
      MemoryNote.make({
        kind: memory.kind,
        content: memory.content,
        scope: noteScope(memory.scope),
      }),
    ),
    older: read.truncated || shown.length < read.memories.length,
  })
}

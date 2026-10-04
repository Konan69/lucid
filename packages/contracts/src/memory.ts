import { Schema } from 'effect'
import { MemoryId, PersonSummary, ThreadId } from './identity.js'

/** What kind of thing is remembered. */
export const MemoryKind = Schema.Literals([
  'fact',
  'preference',
  'person',
  'organization',
  'decision',
  'workstream',
] as const)
export type MemoryKind = typeof MemoryKind.Type

/**
 * Who a memory belongs to, and so who can ever have it recalled.
 *
 * - `Person`: notes with one Person, in one workspace. Nobody else's Thread reads them.
 * - `Company`: what the whole Company should know. Saved only when a Person says so.
 * - `Thread`: what was established in one shared Thread, for the people in it.
 */
export const MemoryScope = Schema.TaggedUnion({
  Person: {},
  Company: {},
  Thread: { threadId: ThreadId, title: Schema.String },
})
export type MemoryScope = typeof MemoryScope.Type

/** One thing Vivid knows, stated so it stands on its own: "Dami prefers morning meetings". */
export const Memory = Schema.Struct({
  id: MemoryId,
  kind: MemoryKind,
  content: Schema.String,
  scope: MemoryScope,
  /** The Thread it was learned in, so a Person can see where Vivid got it. */
  learnedIn: Schema.NullOr(ThreadId),
  /** The Person it was learned from. */
  learnedFrom: PersonSummary,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: 'Memory', title: 'Memory' })
export interface Memory extends Schema.Schema.Type<typeof Memory> {}

/**
 * The page Vivid reads at the start of a Run: who this Person is, how they like to work, and what
 * is in motion. Rebuilt in the background from current memories; `updatedAt` says how fresh it is.
 */
export const MemoryBrief = Schema.Struct({
  text: Schema.String,
  updatedAt: Schema.NullOr(Schema.Number),
}).annotate({ identifier: 'MemoryBrief', title: 'Memory brief' })
export interface MemoryBrief extends Schema.Schema.Type<typeof MemoryBrief> {}

/**
 * Whose a fact on the page is. A Thread's title travels with it, never its identifier: in a
 * private Thread the page also holds facts from the shared Threads this Person can see, and the
 * model can only tell those apart by name.
 */
export const MemoryNoteScope = Schema.TaggedUnion({
  Person: {},
  Company: {},
  Thread: { title: Schema.String },
})
export type MemoryNoteScope = typeof MemoryNoteScope.Type

/**
 * One line of the page: a remembered fact exactly as it is stored, with its kind and whose it is.
 * No identifier or author travels with it; the page is read by the model.
 */
export const MemoryNote = Schema.Struct({
  kind: MemoryKind,
  content: Schema.String,
  scope: MemoryNoteScope,
}).annotate({ identifier: 'MemoryNote', title: 'Memory note' })
export interface MemoryNote extends Schema.Schema.Type<typeof MemoryNote> {}

/**
 * What Vivid knows, placed in front of the model on every response. It is the stored facts
 * themselves, newest first, not a summary of them: nothing is paraphrased and no model runs to
 * build it, so a fact remembered in one response is on the page for the next.
 *
 * The page is bounded. `older` says that facts older than the ones shown exist; they stay stored
 * and `recall` finds them. It is not a count: the store reads only its newest records, so the
 * number left out is not known on this path and a number here would understate it. The design
 * follows the writable memory block of Cloudflare's Agents Session (a bounded block rendered into
 * the system prompt, developers.cloudflare.com/agents "Sessions": context blocks, `maxTokens`),
 * with Vivid's stored memories as the block's content.
 */
export const MemoryPage = Schema.Struct({
  notes: Schema.Array(MemoryNote),
  older: Schema.Boolean,
}).annotate({ identifier: 'MemoryPage', title: 'Memory page' })
export interface MemoryPage extends Schema.Schema.Type<typeof MemoryPage> {}

export const MemoryListResponse = Schema.Struct({
  memories: Schema.Array(Memory),
  brief: MemoryBrief,
})
export interface MemoryListResponse extends Schema.Schema.Type<typeof MemoryListResponse> {}

/** Vivid looking something up. Results come only from scopes the acting Person may read here. */
export const RecallRequest = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  limit: Schema.optionalKey(Schema.Number),
})
export interface RecallRequest extends Schema.Schema.Type<typeof RecallRequest> {}

export const RecallResponse = Schema.Struct({ memories: Schema.Array(Memory) })
export interface RecallResponse extends Schema.Schema.Type<typeof RecallResponse> {}

/**
 * Saving something on purpose. Vivid uses it when a Person asks it to remember, and it is the only
 * way a memory reaches the Company scope.
 */
export const RememberRequest = Schema.Struct({
  kind: MemoryKind,
  content: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1000)),
  forCompany: Schema.Boolean,
})
export interface RememberRequest extends Schema.Schema.Type<typeof RememberRequest> {}

/** A Person correcting what Vivid knows. The old wording is kept as history, not shown. */
export const CorrectMemoryRequest = Schema.Struct({
  id: MemoryId,
  content: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1000)),
})
export interface CorrectMemoryRequest extends Schema.Schema.Type<typeof CorrectMemoryRequest> {}

export const MemoryResponse = Schema.Struct({ memory: Memory })

import { Schema } from 'effect'
import { CompanyId, ThreadId } from './identity.js'

/**
 * What a Person has typed and not sent, kept by the server so it follows them from device to
 * device: a request half-written on the laptop is in the phone's composer a moment later.
 *
 * Drafts were kept on each device alone (`@vivid/state` `drafts`), so words typed on one never
 * reached another. The device still keeps its own copy, which is what makes typing instant and
 * what survives being offline; this is the copy every device converges on.
 *
 * A draft belongs to one Person. No one else ever reads it, in any workspace: it is unsent, so it
 * is nobody's to see yet. The server takes the Person and the workspace from who is calling, and
 * a place never carries either.
 */

/**
 * Where the words were being typed.
 *
 * - `NewThread`: the composer that starts a Thread, in the workspace the caller is in. A request
 *   half-written for one Company must not be waiting in the composer of another, so there is one
 *   of these per workspace and the server keys it by the caller's.
 * - `InThread`: the composer of one Thread the Person can see.
 */
export const DraftPlace = Schema.TaggedUnion({
  NewThread: {},
  InThread: { thread: ThreadId },
})
export type DraftPlace = typeof DraftPlace.Type

/**
 * The workspace a list of drafts is for, by identity alone. A list says which workspace it
 * answers for because a client changes workspace while lists are in flight: one that arrives late
 * for the workspace just left must not be filed under the one just entered, where it would put
 * the wrong words in the new-Thread composer and drop the drafts that belong there.
 */
export const DraftWorkspace = Schema.TaggedUnion({
  Personal: {},
  Company: { company: CompanyId },
})
export type DraftWorkspace = typeof DraftWorkspace.Type

/** Longer than any message a composer accepts is not a draft of one. */
const DraftText = Schema.String.check(Schema.isMaxLength(50_000))

/**
 * One kept draft.
 *
 * `revision` is the Person's draft `generation` (below) at the moment of this save. It therefore
 * only ever rises, across every place and across a clear: a place cleared and typed in again gets
 * a higher revision than it had before, never 1 again. Two devices' saves are ordered by it: the
 * later save as the server received it wins, whole. There is no merge: one Person typing the same
 * message on two devices in the same second is not a case worth a conflict screen. A device
 * applies an arriving draft to its composer only when the Person has no unsaved keystrokes there,
 * so what they are typing right now is never pulled out from under them.
 *
 * Order is decided by `revision` and `generation` alone. `savedAt` is for showing when, and is
 * never compared: two servers' clocks, or one clock stepping back, must not reorder words.
 *
 * `device` is an opaque name the saving client made up for itself and keeps (not a Device id, not
 * a session): it lets a client tell its own save coming back from a change made elsewhere. Two
 * tabs of one browser are two clients and name themselves apart.
 */
export const Draft = Schema.Struct({
  place: DraftPlace,
  text: DraftText,
  revision: Schema.Finite,
  /** Epoch milliseconds of the save, by the server's clock. Never used to order drafts. */
  savedAt: Schema.Finite,
  device: Schema.String,
}).annotate({ identifier: 'Draft', title: 'Draft' })
export interface Draft extends Schema.Schema.Type<typeof Draft> {}

/**
 * The Person's drafts in one workspace, newest first. At most fifty are kept.
 *
 * `generation` is a counter the server keeps for each Person and raises by one on every save and
 * every clear, in any workspace. A list carries the generation it was read at, and so does the
 * answer to a save. That is what lets a device put the two in order: a list read before the
 * device's own save was accepted has a lower generation than that save's answer and is ignored,
 * where it would otherwise delete the words just saved; and a place missing from a list is
 * cleared only when the list's generation is higher than the revision the device holds for it.
 */
export const DraftListResponse = Schema.Struct({
  workspace: DraftWorkspace,
  generation: Schema.Finite,
  drafts: Schema.Array(Draft),
})
export interface DraftListResponse extends Schema.Schema.Type<typeof DraftListResponse> {}

/**
 * Keeps the words for a place. Text that is only space is no draft: saving it removes the draft,
 * which is how sending a message (it empties the composer) clears it everywhere.
 */
export const SaveDraftRequest = Schema.Struct({
  place: DraftPlace,
  text: DraftText,
  device: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
})
export interface SaveDraftRequest extends Schema.Schema.Type<typeof SaveDraftRequest> {}

/**
 * What a save left behind: the draft as kept, or nothing because the place is now empty. Either
 * way it says the Person's `generation` after it, which for `Kept` is the draft's own `revision`.
 */
export const DraftSaved = Schema.TaggedUnion({
  Kept: { draft: Draft, generation: Schema.Finite },
  Cleared: { place: DraftPlace, generation: Schema.Finite },
})
export type DraftSaved = typeof DraftSaved.Type

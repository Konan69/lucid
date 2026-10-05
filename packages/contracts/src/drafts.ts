import { Schema } from 'effect'
import { ThreadId } from './identity.js'

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

/** Longer than any message a composer accepts is not a draft of one. */
const DraftText = Schema.String.check(Schema.isMaxLength(50_000))

/**
 * One kept draft.
 *
 * `revision` counts the saves of this place, from 1. It orders two devices' saves: the later save
 * as the server received it wins, whole, and the earlier words are gone from the server (they are
 * still on the device that typed them until that device takes the newer text). There is no merge:
 * one Person typing the same message on two devices in the same second is not a case worth a
 * conflict screen. A device applies an arriving draft to its composer only when the Person has no
 * unsaved keystrokes there, so what they are typing right now is never pulled out from under them.
 *
 * `device` is an opaque name the saving client made up for itself and keeps (not a Device id, not
 * a session): it lets a client tell its own save coming back from a change made elsewhere.
 */
export const Draft = Schema.Struct({
  place: DraftPlace,
  text: DraftText,
  revision: Schema.Number,
  /** Epoch milliseconds of the save, by the server's clock. */
  savedAt: Schema.Number,
  device: Schema.String,
}).annotate({ identifier: 'Draft', title: 'Draft' })
export interface Draft extends Schema.Schema.Type<typeof Draft> {}

/** The Person's drafts in the caller's workspace, newest first. At most fifty are kept. */
export const DraftListResponse = Schema.Struct({ drafts: Schema.Array(Draft) })
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

/** What a save left behind: the draft as kept, or nothing because the place is now empty. */
export const DraftSaved = Schema.TaggedUnion({
  Kept: { draft: Draft },
  Cleared: { place: DraftPlace },
})
export type DraftSaved = typeof DraftSaved.Type

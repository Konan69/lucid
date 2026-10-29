import * as Schema from 'effect/Schema'
import { OwedId, PersonId, ThreadId } from './identity.js'

/**
 * What a Person is owed: a reply, a delivery, a decision, a payment, anything someone else has to
 * do before the Person's work can move. Vivid keeps the list and chases it, so the Person stops
 * carrying it in their head ([docs/23](../../../docs/23-product-definition.md) "waiting-on
 * tracking", first on the owner's list; [docs/28](../../../docs/28-assistant-patterns.md) section 8).
 *
 * Shape taken from Dots' action-item list (`dots/skills/action-items/SKILL.md`: an item keeps the
 * request versus the accepted commitment, `waiting_on`, `blocked`, a deadline, and closure clears
 * dependents) and Muse's responsibility checklist (`muse/skills/travel-planning/references/
 * operational-itinerary.md`: every open outcome with owner, status, next action, evidence and
 * deadline). Vivid's names, one record per thing owed.
 *
 * A record belongs to one Person and names the Thread it came from, so the Feed and the Thread
 * both show it and a nudge goes back where the Person can read it.
 */

/** Who owes it, as the Person says it: a name, "the landlord", "Acme support". Never an id. */
const Party = Schema.NonEmptyString.check(Schema.isMaxLength(120))
/** What is owed, in the Person's words: "the signed NDA", "a reply about Friday". */
const What = Schema.NonEmptyString.check(Schema.isMaxLength(240))
/** The next thing Vivid or the Person does about it. */
const NextStep = Schema.NonEmptyString.check(Schema.isMaxLength(240))

/**
 * Where a record stands. Each state owns only what is true while it is active: a nudge count
 * exists only once a nudge was sent; a resolution says how it resolved; a drop says why.
 */
export const OwedState = Schema.TaggedUnion({
  /** Nothing chased yet. */
  Open: {},
  /** Vivid chased it: when last, and how many times in all. */
  Nudged: { lastAt: Schema.Finite, count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) },
  /** The Person has it, or it no longer matters because it arrived. */
  Resolved: { at: Schema.Finite, how: Schema.NonEmptyString.check(Schema.isMaxLength(240)) },
  /** The Person stopped caring. Kept so the same thing is not tracked twice. */
  Dropped: { at: Schema.Finite, why: Schema.NonEmptyString.check(Schema.isMaxLength(240)) },
})
export type OwedState = typeof OwedState.Type

export class Owed extends Schema.Class<Owed>('Owed')(
  {
    id: OwedId,
    /** The Person it is owed to. Attribution, never tenancy. */
    personId: PersonId,
    /** The Thread the commitment was made or noticed in. Nudges and results return here. */
    threadId: ThreadId,
    what: What,
    from: Party,
    /** When the Person started waiting (the ask, the promise, the order). */
    since: Schema.Finite,
    /** When it is needed by, when there is a date. Absent is a real state: no deadline. */
    due: Schema.NullOr(Schema.Finite),
    /** What it is stuck on, when Vivid knows. */
    blockedOn: Schema.NullOr(What),
    nextStep: NextStep,
    state: OwedState,
    updatedAt: Schema.Finite,
  },
  { title: 'Owed' },
) {}

/** Vivid starts tracking something it heard or noticed. */
export class TrackOwedRequest extends Schema.Class<TrackOwedRequest>('TrackOwedRequest')(
  {
    threadId: ThreadId,
    what: What,
    from: Party,
    since: Schema.Finite,
    due: Schema.NullOr(Schema.Finite),
    nextStep: NextStep,
  },
  { title: 'Track owed request' },
) {}

/** Vivid or the Person changes what is known: a new deadline, what it is stuck on, the next step. */
export class UpdateOwedRequest extends Schema.Class<UpdateOwedRequest>('UpdateOwedRequest')(
  {
    id: OwedId,
    due: Schema.NullOr(Schema.Finite),
    blockedOn: Schema.NullOr(What),
    nextStep: NextStep,
  },
  { title: 'Update owed request' },
) {}

/** Vivid chased it (a nudge went out, as a draft the Person sent or an action they allowed). */
export class NudgedOwedRequest extends Schema.Class<NudgedOwedRequest>('NudgedOwedRequest')(
  { id: OwedId, at: Schema.Finite },
  { title: 'Nudged owed request' },
) {}

export class ResolveOwedRequest extends Schema.Class<ResolveOwedRequest>('ResolveOwedRequest')(
  { id: OwedId, how: Schema.NonEmptyString.check(Schema.isMaxLength(240)) },
  { title: 'Resolve owed request' },
) {}

export class DropOwedRequest extends Schema.Class<DropOwedRequest>('DropOwedRequest')(
  { id: OwedId, why: Schema.NonEmptyString.check(Schema.isMaxLength(240)) },
  { title: 'Drop owed request' },
) {}

/** Open and nudged first, soonest due first; resolved and dropped after, newest first. */
export class OwedListResponse extends Schema.Class<OwedListResponse>('OwedListResponse')(
  { owed: Schema.Array(Owed) },
  { title: 'Owed list response' },
) {}

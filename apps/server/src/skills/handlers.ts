import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import {
  Conflict,
  Forbidden,
  NotFound,
  SkillSummary,
  SkillOrigin,
  SkillReadOnly,
  type SkillId,
  type SaveSkillRequest,
  type PatchSkillRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { changed, Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { SkillStore, type SkillStoreError } from './store.ts'
import { summary } from './builtin/index.ts'

/** Expected domain failures become the fixed RPC variants without exposing foreign ownership. */
const skillFailure = (error: SkillStoreError) =>
  Match.value(error).pipe(
    Match.tag(
      'SkillReadOnly',
      () => new Forbidden({ message: 'Save your own procedure to change built-in instructions' }),
    ),
    Match.tag('SkillMissing', () => new NotFound({ message: 'Skill was not found' })),
    Match.tag(
      'SkillNotEditable',
      () => new Forbidden({ message: 'Only the owner or a Company admin can change this skill' }),
    ),
    Match.tag(
      'SkillNameTaken',
      () => new Conflict({ message: 'A skill with this name already exists in this scope' }),
    ),
    Match.orElse((other) => other),
  )

/** Only mutation RPCs expose the read-only variant; ordinary reads keep their existing failures. */
const mutationFailure = (error: SkillStoreError) =>
  error instanceof SkillReadOnly ? error : skillFailure(error)

/** List and Watch share their loader so the subscribed view has identical access rules. */
const loadSkills = Effect.fn('Skills.load')(function* (actor: Actor) {
  return { skills: yield* (yield* SkillStore).list(actor) }
})

export const skillHandlers = {
  /** RPC decoding is supplied by VividRpc before this handler sees the payload. */
  ListSkills: Effect.fn('Rpc.ListSkills')(function* () {
    return yield* loadSkills(yield* requireActor())
  }),
  /** A workspace switch re-scopes this same loader through the shared live query authority. */
  WatchSkills: () => live('WatchSkills', [], loadSkills),
  /** Summaries intentionally omit instructions until Vivid chooses a procedure. */
  ListSkillSummaries: Effect.fn('Rpc.ListSkillSummaries')(function* () {
    const { skills } = yield* loadSkills(yield* requireActor())
    return {
      skills: skills.map((skill) =>
        SkillSummary.make({
          id: skill.id,
          name: skill.name,
          useWhen: summary(skill),
          createdAt: skill.createdAt,
        }),
      ),
    }
  }),
  /** Reading is available to everyone who can list the procedure. */
  ReadSkill: Effect.fn('Rpc.ReadSkill')(function* ({ id }: { readonly id: SkillId }) {
    return {
      skill: yield* (yield* SkillStore)
        .read(yield* requireActor(), id)
        .pipe(Effect.mapError(skillFailure)),
    }
  }),
  /** A successful save refreshes personal and active Company subscriptions. */
  SaveSkill: Effect.fn('Rpc.SaveSkill')(function* (request: SaveSkillRequest) {
    const actor = yield* requireActor()
    const skill = yield* (yield* SkillStore)
      .save(actor, request)
      .pipe(Effect.mapError(skillFailure))
    yield* changed(actor)
    return { skill }
  }),
  /** An admin editing another Person's procedure also invalidates its owner's subscriptions. */
  PatchSkill: Effect.fn('Rpc.PatchSkill')(function* ({
    id,
    patch,
  }: {
    readonly id: SkillId
    readonly patch: PatchSkillRequest
  }) {
    const actor = yield* requireActor()
    const skill = yield* (yield* SkillStore)
      .patch(actor, id, patch)
      .pipe(Effect.mapError(mutationFailure))
    if (SkillOrigin.guards.Saved(skill.origin))
      yield* changed(actor, Topic.person(skill.origin.createdBy.id))
    return { skill }
  }),
  /** Load the authorized owner before removal so their open view receives the deletion too. */
  DeleteSkill: Effect.fn('Rpc.DeleteSkill')(function* ({ id }: { readonly id: SkillId }) {
    const actor = yield* requireActor()
    const store = yield* SkillStore
    const skill = yield* store.read(actor, id).pipe(Effect.mapError(skillFailure))
    yield* store.remove(actor, id).pipe(Effect.mapError(mutationFailure))
    if (SkillOrigin.guards.Saved(skill.origin))
      yield* changed(actor, Topic.person(skill.origin.createdBy.id))
  }),
}

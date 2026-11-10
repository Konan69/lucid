import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import {
  Conflict,
  NotFound,
  SkillSummary,
  type SkillId,
  type SaveSkillRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { SkillStore, type SkillStoreError } from './store.ts'
import { summary } from './builtin/index.ts'

/** Expected domain failures become the fixed RPC variants without exposing foreign ownership. */
const skillFailure = (error: SkillStoreError) =>
  Match.value(error).pipe(
    Match.tag('SkillMissing', () => new NotFound({ message: 'Skill was not found' })),
    Match.tag(
      'SkillNameTaken',
      () => new Conflict({ message: 'A skill with this name already exists in this scope' }),
    ),
    Match.orElse((other) => other),
  )

/** List and the summaries share their loader so both read with identical access rules. */
const loadSkills = Effect.fn('Skills.load')(function* (actor: Actor) {
  return { skills: yield* (yield* SkillStore).list(actor) }
})

export const skillHandlers = {
  /** RPC decoding is supplied by VividRpc before this handler sees the payload. */
  ListSkills: Effect.fn('Rpc.ListSkills')(function* () {
    return yield* loadSkills(yield* requireActor())
  }),
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
}

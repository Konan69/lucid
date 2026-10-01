import { SkillSummary, type PersonId, type ThreadId } from '@vivid/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Acting } from '../client.ts'

export const VividContext = Schema.Struct({
  brief: Schema.String,
  skills: Schema.Array(SkillSummary),
  timezone: Schema.String,
})
export interface VividContext extends Schema.Schema.Type<typeof VividContext> {}

/** Each response owns a Thread/Person pair; finishing it cannot evict another Person's context. */
export function contextSnapshots() {
  const prepared = new Map<ThreadId, Map<PersonId, VividContext>>()
  const frozen = new Map<ThreadId, Map<PersonId, Option.Option<VividContext>>>()

  /** Preloads affect the next response; an already frozen pair keeps its original value. */
  function prepare(who: Acting, context: VividContext) {
    const people = new Map(prepared.get(who.threadId))
    people.set(who.personId, context)
    prepared.set(who.threadId, people)
  }

  /** Freeze only this Person, including deliberate absence so late preloads cannot alter a response. */
  function freeze(who: Acting) {
    const contexts = prepared.get(who.threadId)
    const context =
      contexts === undefined ? Option.none() : Option.fromUndefinedOr(contexts.get(who.personId))
    const people = new Map(frozen.get(who.threadId))
    people.set(who.personId, context)
    frozen.set(who.threadId, people)
  }

  /** A pair without a frozen response reads its own prepared value, never another Person's snapshot. */
  function read(who: Acting): Option.Option<VividContext> {
    const response = frozen.get(who.threadId)
    if (response !== undefined) {
      const context = response.get(who.personId)
      if (context !== undefined) return context
    }
    const contexts = prepared.get(who.threadId)
    return contexts === undefined
      ? Option.none()
      : Option.fromUndefinedOr(contexts.get(who.personId))
  }

  /** Remove only the finishing pair and release Thread containers when their last Person finishes. */
  function finish(who: Acting) {
    const response = frozen.get(who.threadId)
    if (response !== undefined) {
      response.delete(who.personId)
      if (response.size === 0) frozen.delete(who.threadId)
    }
    const contexts = prepared.get(who.threadId)
    if (contexts !== undefined) {
      contexts.delete(who.personId)
      if (contexts.size === 0) prepared.delete(who.threadId)
    }
  }

  return { prepare, freeze, read, finish }
}

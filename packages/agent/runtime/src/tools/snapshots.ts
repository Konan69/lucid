import { SkillSummary, VividName, type PersonId, type ThreadId } from '@vivid/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Acting } from '../client.ts'

/** Creation time is internal naming evidence; instructions remain out of the context catalog. */
export const ContextSkill = SkillSummary
export interface ContextSkill extends Schema.Schema.Type<typeof ContextSkill> {}

/** A successful server catalogue always includes all shipped skills, even with no saved rows.
 * Its empty fallback therefore means summaries are unavailable/unprepared, not an empty saved set.
 * The tagged projection preserves that distinction without changing response-preload ownership. */
export const SavedProcedures = Schema.TaggedUnion({
  Available: {
    skills: Schema.Array(Schema.Struct({ name: Schema.String, useWhen: Schema.String })),
  },
  Unavailable: {
    message: Schema.Literal(
      'Saved procedures are unavailable right now; continue with the built-in skills.',
    ),
  },
})
export type SavedProcedures = typeof SavedProcedures.Type

export const VividContext = Schema.Struct({
  brief: Schema.String,
  skills: Schema.Array(ContextSkill),
  timezone: Schema.String,
  /** Names observed on this Computer; an empty list means no current installation proof. */
  apps: Schema.Array(Schema.String),
  /**
   * The services this Person has connected and that are ready to use, by the name people know
   * them ("Gmail"). Names only: accounts and tools are still resolved through find_tools. Without
   * this the model cannot know a named service is connected and reaches for a page or a browser
   * first (seen on production, 4 October 2026: seven wasted calls before find_tools).
   */
  integrations: Schema.Array(Schema.String),
  /** What Vivid is called where this Person is working; "Vivid" until someone renames it. */
  name: VividName,
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

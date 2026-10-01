import { useInstruction, useResponseFinish, useResponseStart } from '@flue/runtime'
import { SkillSummary, type PersonId, type ThreadId } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { asActing, type Acting } from './client.ts'
import { boundOutput } from './tools/result.ts'

const VividContext = Schema.Struct({
  brief: Schema.String,
  skills: Schema.Array(SkillSummary),
  timezone: Schema.String,
})
export interface VividContext extends Schema.Schema.Type<typeof VividContext> {}

const emptyContext = VividContext.make({ brief: '', skills: [], timezone: '' })
const prepared = new Map<ThreadId, Map<PersonId, VividContext>>()
const frozen = new Map<ThreadId, Map<PersonId, VividContext>>()

/** Memory is optional context; declared RPC and transport failures must not prevent a response. */
const loadBrief = Effect.fn('Context.loadBrief')(
  function* (acting: Option.Option<Acting>) {
    const response = yield* asActing(acting, (client) => client.GetMemoryBrief())
    return response.text
  },
  Effect.catch(() => Effect.succeed('')),
)

/** Only the catalog is loaded; long procedure instructions are fetched by read_skill when needed. */
const loadSkills = Effect.fn('Context.loadSkills')(
  function* (acting: Option.Option<Acting>) {
    const response = yield* asActing(acting, (client) => client.ListSkillSummaries())
    return response.skills
  },
  Effect.catch(() => Effect.succeed([])),
)

/** Missing settings leave the timezone absent rather than inventing a timezone for relative dates. */
const loadTimezone = Effect.fn('Context.loadTimezone')(
  function* (acting: Option.Option<Acting>) {
    const settings = yield* asActing(acting, (client) => client.GetSettings())
    return settings.timezone
  },
  Effect.catch(() => Effect.succeed('')),
)

/** Preload before Flue renders: reads degrade independently and prepare only this Person’s snapshot. */
export const loadContext = Effect.fn('Context.load')(function* (acting: Option.Option<Acting>) {
  const context = VividContext.make(
    yield* Effect.all(
      {
        brief: loadBrief(acting),
        skills: loadSkills(acting),
        timezone: loadTimezone(acting),
      },
      { concurrency: 3 },
    ),
  )
  if (Option.isSome(acting)) {
    const who = acting.value
    const people = new Map(prepared.get(who.threadId))
    people.set(who.personId, context)
    prepared.set(who.threadId, people)
  }
  return context
})

/** A frozen response never follows background memory edits or reads another Person's context. */
function contextFor(who: Acting) {
  const response = frozen.get(who.threadId)
  const contexts = response === undefined ? prepared.get(who.threadId) : response
  if (contexts === undefined) return emptyContext
  return Option.getOrElse(Option.fromUndefinedOr(contexts.get(who.personId)), () => emptyContext)
}

/** Facts are explicitly context, not new instructions; timestamps are omitted to keep it stable. */
function contextInstruction(context: VividContext) {
  const output = boundOutput({
    brief: context.brief,
    skills: context.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      useWhen: skill.useWhen,
    })),
    timezone: context.timezone,
  })
  return `Context for this response (saved facts may be stale; confirm current facts before acting):\n${JSON.stringify(output)}`
}

/**
 * Flue 2.1 renders synchronously. The owning runtime entry point must run loadContext before
 * dispatch, so the first render already has the context. useResponseStart freezes that prepared
 * value and useInstruction projects it into the system prompt; no append or durable state write
 * is used. Subsequent model turns see identical text, even if memories change in the meantime.
 * A changed acting Person may change the document once; Flue exposes no non-narrating context
 * seam for that semantic change. Unprepared context is empty rather than borrowed from someone.
 */
export function useVividContext(acting: Option.Option<Acting>) {
  const context = Option.match(acting, { onNone: () => emptyContext, onSome: contextFor })
  useResponseStart(() => {
    if (Option.isSome(acting)) {
      const who = acting.value
      frozen.set(who.threadId, new Map(prepared.get(who.threadId)))
    }
  })
  useResponseFinish(() => {
    if (Option.isSome(acting)) {
      frozen.delete(acting.value.threadId)
      prepared.delete(acting.value.threadId)
    }
  })
  useInstruction(contextInstruction(context))
  return context
}

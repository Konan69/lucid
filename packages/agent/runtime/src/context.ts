import { useInstruction, useResponseFinish, useResponseStart } from '@flue/runtime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { asActing, type Acting } from './client.ts'
import * as views from './tools/views.ts'
import { boundOutput } from './tools/result.ts'
import { contextSnapshots, VividContext } from './tools/snapshots.ts'

export type { VividContext } from './tools/snapshots.ts'

const emptyContext = VividContext.make({ brief: '', skills: [], timezone: '' })
const snapshots = contextSnapshots()

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
  if (Option.isSome(acting)) snapshots.prepare(acting.value, context)
  return context
})

/** A frozen response never follows background memory edits or reads another Person's context. */
function contextFor(who: Acting) {
  return Option.getOrElse(snapshots.read(who), () => emptyContext)
}

/** Facts are explicitly context, not new instructions; timestamps are omitted to keep it stable. */
export function contextInstruction(context: VividContext) {
  const output = boundOutput({
    brief: views.modelText(context.brief),
    skills: views.skills(context.skills),
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
    if (Option.isSome(acting)) snapshots.freeze(acting.value)
  })
  useResponseFinish(() => {
    if (Option.isSome(acting)) snapshots.finish(acting.value)
  })
  useInstruction(contextInstruction(context))
  return context
}

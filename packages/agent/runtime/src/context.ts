import { useInstruction, useResponseFinish, useResponseStart } from '@flue/runtime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  ComputerInventory,
  ConnectionState,
  DEFAULT_APPEARANCE,
  type VividName,
} from '@vivid/contracts'
import { asActing, type Acting } from './client.ts'
import * as views from './tools/views.ts'
import { boundOutput } from './tools/result.ts'
import { ContextSkill, contextSnapshots, VividContext } from './tools/snapshots.ts'

export type { VividContext } from './tools/snapshots.ts'

const emptyContext = VividContext.make({
  brief: '',
  skills: [],
  timezone: '',
  apps: [],
  integrations: [],
  name: DEFAULT_APPEARANCE.name,
})
const snapshots = contextSnapshots()

/** Runtime context names only observed installations. A failed read contributes no app claim;
 * provider identifiers, package paths and capability descriptions never enter the model prompt. */
const loadApps = Effect.fn('Context.loadApps')(
  function* (acting: Option.Option<Acting>) {
    const inventory = yield* asActing(acting, (client) => client.GetComputerApps())
    return ComputerInventory.match(inventory, {
      Unavailable: () => [],
      Installed: ({ apps }) => apps.map((app) => app.name),
    })
  },
  Effect.catch(() => Effect.succeed([])),
)

/** Memory is optional context; declared RPC and transport failures must not prevent a response. */
const loadBrief = Effect.fn('Context.loadBrief')(
  function* (acting: Option.Option<Acting>) {
    const response = yield* asActing(acting, (client) => client.GetMemoryBrief())
    return response.text
  },
  Effect.catch(() => Effect.succeed('')),
)

/** Summaries supply immutable creation order without transporting every procedure's instructions. */
const loadSkills = Effect.fn('Context.loadSkills')(
  function* (acting: Option.Option<Acting>) {
    const response = yield* asActing(acting, (client) => client.ListSkillSummaries())
    return response.skills.map((skill) =>
      ContextSkill.make({
        id: skill.id,
        name: skill.name,
        useWhen: skill.useWhen,
        createdAt: skill.createdAt,
      }),
    )
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

/**
 * The names of the services this Person can use now. A Connection that still needs authorization
 * or has failed is left out, because naming it would promise tools that find_tools will not
 * return. One service connected twice is named once; the accounts are find_tools' to tell apart.
 * A failed read names nothing rather than failing the response.
 */
const loadIntegrations = Effect.fn('Context.loadIntegrations')(
  function* (acting: Option.Option<Acting>) {
    const response = yield* asActing(acting, (client) => client.ListConnections())
    const ready = response.connections.filter((connection) =>
      ConnectionState.guards.Ready(connection.state),
    )
    return [...new Set(ready.map((connection) => connection.serviceName))]
  },
  Effect.catch(() => Effect.succeed([])),
)

/**
 * What Vivid is called where this Person is working. When it cannot be read Vivid answers under
 * its own name, which is true of it everywhere, rather than failing the response over a nickname.
 */
const loadName = Effect.fn('Context.loadName')(
  function* (acting: Option.Option<Acting>) {
    const appearance = yield* asActing(acting, (client) => client.GetAppearance())
    return appearance.name
  },
  Effect.catch(() => Effect.succeed(DEFAULT_APPEARANCE.name)),
)

/**
 * The lines that tell the model its name, as plain text and never an identifier. Nothing is said
 * while the name is still Vivid: the voice already opens with it. A chosen name is at most 24
 * characters on one line with no backslash (`VividName`), so it cannot carry an instruction.
 */
export const namedAs = (name: VividName): ReadonlyArray<string> =>
  name === DEFAULT_APPEARANCE.name
    ? []
    : [
        `Here you have been given the name ${name}. Answer to it and use it when you say who you are. If someone asks what you are, you are ${name}, their Vivid.`,
      ]

/** Preload before Flue renders: reads degrade independently and prepare only this Person’s snapshot. */
export const loadContext = Effect.fn('Context.load')(function* (acting: Option.Option<Acting>) {
  const context = VividContext.make(
    yield* Effect.all(
      {
        brief: loadBrief(acting),
        skills: loadSkills(acting),
        timezone: loadTimezone(acting),
        integrations: loadIntegrations(acting),
        name: loadName(acting),
        apps: loadApps(acting),
      },
      { concurrency: 5 },
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
    apps: context.apps.map(views.modelText),
    integrations: context.integrations.map(views.modelText),
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

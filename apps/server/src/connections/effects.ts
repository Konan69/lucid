import { Cache, Context, Data, Effect, Exit, Layer, Request, RequestResolver, Schema } from 'effect'
import { Decision, DecisionModel } from 'effect/unstable/ai'
import { type ServiceId } from '@vivid/contracts'
import {
  decide,
  decideWithin,
  decisionConfigured,
  DecisionUnavailable,
} from '../decisions/model.ts'
import { ExecutorTool } from './executor.ts'

/** Removing an Approval requires near-certainty, rather than merely the top label.
 * Live Jev calibration (36 tools, 2026-10-04): 18 reads had read probability
 * 0.98–1; 12 writes 0–0.01; six destructive tools 0. All labels matched, no
 * threshold misses. A repeat run measured reads 0.95–1, writes and destructive
 * tools 0, again no misses. The empty 0.01–0.95 band supports retaining 0.95. */
export const READ_PROBABILITY_THRESHOLD = 0.95
/** Bound process memory while retaining several large provider catalogs. */
const EFFECT_CACHE_CAPACITY = 4096
/** Successful metadata judgments survive discovery and execution for one day. */
const EFFECT_CACHE_TTL = '24 hours'
/** One minute suppresses outage storms without remembering failure as an answer. */
const EFFECT_FAILURE_TTL = '1 minute'
/** Forty tools fit one cold catalog; larger catalogs split to bound request payloads. */
export const EFFECT_BATCH_SIZE = 40
/** Discovery is optional enrichment; a stalled provider gets only two seconds. */
export const EFFECT_BATCH_BUDGET = '2 seconds'

/** Request mode changes the lookup budget, not cache identity or caller authority. */
const discoveryClassification = Context.Reference('vivid/DiscoveryClassification', {
  defaultValue: () => false,
})

const Input = Schema.Struct({
  service: Schema.String,
  tool: Schema.String,
  description: Schema.String,
})

/** Adapt `jevtry/try.ts` ToolEffect's System One classification mechanism. Effect rc.116 Decision.ts
 * classify preserves typed labels; DecisionModel.ts make validates full distributions. */
export const toolEffectDecision = Decision.make({
  input: Input,
  decisions: {
    effect: Decision.classify({
      instructions: 'What calling this tool does to the outside service',
      criteria: {
        read: 'Only looks up, searches, lists or answers a question; nothing is created, changed, sent or removed',
        write: 'Creates, updates, sends or posts something that can be undone or edited later',
        destructive:
          'Deletes, removes, revokes or overwrites something in a way that cannot be undone',
      },
    }),
  },
})

interface EffectRequest {
  readonly serviceId: ServiceId
  readonly service: string
  readonly tool: typeof ExecutorTool.Type
}

interface ToolEffectsService {
  readonly classify: (request: EffectRequest) => Effect.Effect<typeof ExecutorTool.Type.effect>
  readonly classifyBatch: (request: {
    readonly serviceId: ServiceId
    readonly service: string
    readonly tools: readonly (typeof ExecutorTool.Type)[]
  }) => Effect.Effect<readonly (typeof ExecutorTool.Type)[]>
}

/** Owns provider classification and its process-lifetime cache across discovery and execution. */
export class ToolEffects extends Context.Service<ToolEffects, ToolEffectsService>()(
  'vivid/ToolEffects',
) {}

/** Structural equality deduplicates Connections sharing tool metadata. The description
 * itself invalidates changed metadata; hashing it again adds no cache identity. */
class CacheKey extends Data.Class<{
  readonly serviceId: ServiceId
  readonly service: string
  readonly tool: string
  readonly description: string
}> {}

/** Resolver requests carry the original metadata; Cache owns cross-caller deduplication. */
class Classification extends Request.Class<
  {
    readonly key: CacheKey
    readonly discovery: boolean
  },
  typeof ExecutorTool.Type.effect,
  DecisionUnavailable
> {}

/** Separate catalogs and budgets must not share a provider request. */
class ClassificationGroup extends Data.Class<{
  readonly serviceId: ServiceId
  readonly service: string
  readonly discovery: boolean
}> {}

/** The established classification wording and labels remain authoritative in batches. */
const effectOf = (
  answer: Decision.ClassifyAnswer<'read' | 'write' | 'destructive'>,
): typeof ExecutorTool.Type.effect => {
  if (answer.probabilities.read >= READ_PROBABILITY_THRESHOLD) return 'read'
  return answer.label === 'destructive' ? 'destructive' : 'write'
}

/** Direct use keeps the original single-tool prompt and ten-second trust-loop budget. */
const judgeEffect = Effect.fn('Connections.judgeEffect')(function* (key: CacheKey) {
  const { answers } = yield* decide(toolEffectDecision, {
    service: key.service,
    tool: key.tool,
    description: key.description,
  })
  return effectOf(answers.effect)
})

/** Positional questions keep each tool's facts beside its criteria. rc.116
 * DecisionModel.make validates coverage; a missing dynamic key still fails explicitly.
 * Discovery uses a single two-second attempt, with no failure converted to an answer. */
const classifyQuestions = Effect.fn('Connections.classifyQuestions')(function* (
  keys: readonly CacheKey[],
) {
  const decisions = Object.fromEntries(
    keys.map((key, index) => [
      `tool_${index}`,
      Decision.classify({
        ...toolEffectDecision.decisions.effect,
        instructions: `${toolEffectDecision.decisions.effect.instructions}. Judge only this tool: ${JSON.stringify({ service: key.service, tool: key.tool, description: key.description })}`,
      }),
    ]),
  )
  const { answers } = yield* decideWithin(
    Decision.make({ input: Schema.Struct({}), decisions }),
    {},
    EFFECT_BATCH_BUDGET,
  )
  return yield* Effect.forEach(keys, (_, index) => {
    const answer = answers[`tool_${index}`]
    if (answer === undefined) return Effect.fail(new DecisionUnavailable({ reason: 'Provider' }))
    return Effect.succeed(effectOf(answer))
  })
})

/** RequestResolver.ts makeGrouped collects concurrently requested cache misses in one
 * catalog; batchN bounds payloads. Cache.ts makeWith owns pending deduplication and
 * exit-dependent expiry across discovery, direct use and delayed use. Declared hints
 * bypass Jev, and the unconfigured model bypasses the cache entirely. */
export const toolEffectsLayer = Layer.effect(
  ToolEffects,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    const configured = yield* decisionConfigured
    const resolver = RequestResolver.makeGrouped<Classification, ClassificationGroup>({
      key: ({ request }) =>
        new ClassificationGroup({
          serviceId: request.key.serviceId,
          service: request.key.service,
          discovery: request.discovery,
        }),
      resolver: Effect.fn('Connections.resolveEffects')(function* (entries, group) {
        // Each direct call owns its failure; one provider error must not poison neighboring keys.
        if (!group.discovery) {
          yield* Effect.forEach(
            entries,
            (entry) => Request.completeEffect(entry, judgeEffect(entry.request.key)),
            { concurrency: 'unbounded', discard: true },
          ).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
          return
        }
        const keys = entries.map(({ request }) => request.key)
        const exit = yield* Effect.exit(
          classifyQuestions(keys).pipe(Effect.provideService(DecisionModel.DecisionModel, model)),
        )
        for (const [index, entry] of entries.entries()) {
          if (Exit.isFailure(exit)) yield* Request.failCause(entry, exit.cause)
          else {
            const effect = exit.value[index]
            yield* Request.complete(
              entry,
              effect === undefined
                ? Exit.fail(new DecisionUnavailable({ reason: 'Provider' }))
                : Exit.succeed(effect),
            )
          }
        }
      }),
    }).pipe(RequestResolver.batchN(EFFECT_BATCH_SIZE))
    const cache = yield* Cache.makeWith(
      Effect.fn('Connections.lookupEffect')(function* (key: CacheKey) {
        const discovery = yield* discoveryClassification
        return yield* Effect.request(new Classification({ key, discovery }), resolver).pipe(
          Effect.tapError((error) =>
            Effect.logWarning('Tool effect unavailable', {
              tag: error._tag,
              reason: error.reason,
            }),
          ),
        )
      }),
      {
        capacity: EFFECT_CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? EFFECT_CACHE_TTL : EFFECT_FAILURE_TTL),
      },
    )
    /** The cache key excludes mode, so competing discovery/use callers share one lookup. */
    const classify = Effect.fn('Connections.toolEffect')(function* ({
      serviceId,
      service,
      tool,
    }: EffectRequest) {
      if (tool.effect !== 'write' || !configured) return tool.effect
      const key = new CacheKey({
        serviceId,
        service,
        tool: tool.name,
        description: tool.description,
      })
      return yield* Cache.get(cache, key).pipe(
        Effect.catch(() => Effect.succeed<typeof ExecutorTool.Type.effect>('write')),
      )
    })
    return ToolEffects.of({
      classify,
      /** Concurrent misses reach one resolver batch; successful exits fill the same cache.
       * Failed exits retain only the brief outage backoff, never a successful write answer. */
      classifyBatch: Effect.fn('Connections.toolEffects')(function* ({
        serviceId,
        service,
        tools,
      }) {
        return yield* Effect.forEach(
          tools,
          Effect.fn('Connections.projectEffect')(function* (tool) {
            const effect = yield* classify({ serviceId, service, tool })
            return ExecutorTool.make({ ...tool, effect })
          }),
          { concurrency: 'unbounded' },
        ).pipe(Effect.provideService(discoveryClassification, true))
      }),
    })
  }),
)

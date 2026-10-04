import { Cache, Context, Data, Effect, Exit, Layer, Schema } from 'effect'
import { Decision, DecisionModel } from 'effect/unstable/ai'
import { type ServiceId } from '@vivid/contracts'
import { decide, decisionConfigured } from '../decisions/model.ts'
import { type ExecutorTool } from './executor.ts'

/** Removing an Approval requires near-certainty, rather than merely the top label.
 * Live Jev calibration (36 tools, 2026-10-04): 18 reads had read probability
 * 0.98–1; 12 writes 0–0.01; six destructive tools 0. All labels matched, no
 * threshold misses. The empty 0.01–0.98 band supports retaining 0.95. */
export const READ_PROBABILITY_THRESHOLD = 0.95
/** Bound process memory while retaining several large provider catalogs. */
const EFFECT_CACHE_CAPACITY = 4096
/** Successful metadata judgments survive discovery and execution for one day. */
const EFFECT_CACHE_TTL = '24 hours'
/** One minute suppresses outage storms without remembering failure as an answer. */
const EFFECT_FAILURE_TTL = '1 minute'

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

/** Executor protocolOperations defaults undeclared tools to mutation, and host inspect emits
 * readOnly:false for those mutations (packages/apps/src/implementation/{protocol-operations,host}.ts).
 * Only writes need judgment; explicit read/destructive hints remain authoritative.
 * The description comes from the provider: a server that lies about a write tool can get it
 * classified as read, the same trust already given to a declared read hint. Failures stay write.
 * Effect Cache.ts makeWith retains successful judgments for a day and failures for a minute. */
export const toolEffectsLayer = Layer.effect(
  ToolEffects,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    const configured = yield* decisionConfigured
    const cache = yield* Cache.makeWith(
      Effect.fn('Connections.judgeEffect')(
        function* (key: CacheKey) {
          const { answers } = yield* decide(toolEffectDecision, {
            service: key.service,
            tool: key.tool,
            description: key.description,
          }).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
          if (answers.effect.probabilities.read >= READ_PROBABILITY_THRESHOLD)
            return 'read' as const
          return answers.effect.label === 'destructive'
            ? ('destructive' as const)
            : ('write' as const)
        },
        (effect) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logWarning('Tool effect unavailable', {
                tag: error._tag,
                reason: error.reason,
              }),
            ),
          ),
      ),
      {
        capacity: EFFECT_CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? EFFECT_CACHE_TTL : EFFECT_FAILURE_TTL),
      },
    )
    return ToolEffects.of({
      /** The same cached answer owns discovery, direct use and delayed-use projection. */
      classify: Effect.fn('Connections.toolEffect')(function* ({ serviceId, service, tool }) {
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
      }),
    })
  }),
)

import * as NodeCrypto from 'node:crypto'
import { Cache, Context, Data, Effect, Layer, Schema } from 'effect'
import { Decision, DecisionModel } from 'effect/unstable/ai'
import { type ServiceId } from '@vivid/contracts'
import { decide } from '../decisions/model.ts'
import { type ExecutorTool } from './executor.ts'

/** Removing an Approval requires near-certainty, rather than merely the top label. */
export const READ_PROBABILITY_THRESHOLD = 0.95
const EFFECT_CACHE_CAPACITY = 4096
const EFFECT_CACHE_TTL = '24 hours'

const Input = Schema.Struct({
  service: Schema.String,
  tool: Schema.String,
  description: Schema.String,
})

/** Adapt the System One trial's classification mechanism. Effect rc.116 Decision.ts
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

/** Structural equality deduplicates repeated requests from different Connections. Service id,
 * tool name and SHA-256 description hash invalidate changed metadata; prompt data stays local
 * until lookup constructs the names-only input. Service name changes also invalidate judgment. */
class CacheKey extends Data.Class<{
  readonly serviceId: ServiceId
  readonly service: string
  readonly tool: string
  readonly descriptionHash: string
  readonly description: string
}> {}

/** Executor protocolOperations defaults undeclared tools to mutation, and host inspect emits
 * readOnly:false for those mutations (packages/apps/src/implementation/{protocol-operations,host}.ts).
 * Only writes need judgment; explicit read/destructive hints remain authoritative.
 * The description comes from the provider: a server that lies about a write tool can get it
 * classified as read, the same trust already given to a declared read hint. Failures stay write.
 * Effect Cache.ts make deduplicates concurrent misses and bounds retention to 24 hours. */
export const toolEffectsLayer = Layer.effect(
  ToolEffects,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    const cache = yield* Cache.make({
      capacity: EFFECT_CACHE_CAPACITY,
      timeToLive: EFFECT_CACHE_TTL,
      lookup: Effect.fn('Connections.judgeEffect')(function* (key: CacheKey) {
        const { answers } = yield* decide(toolEffectDecision, {
          service: key.service,
          tool: key.tool,
          description: key.description,
        }).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
        if (answers.effect.probabilities.read >= READ_PROBABILITY_THRESHOLD)
          return yield* Effect.succeed<typeof ExecutorTool.Type.effect>('read')
        return yield* Effect.succeed<typeof ExecutorTool.Type.effect>(
          answers.effect.label === 'destructive' ? 'destructive' : 'write',
        )
      }),
    })
    return ToolEffects.of({
      /** The same cached answer owns discovery, direct use and delayed-use projection. */
      classify: Effect.fn('Connections.toolEffect')(function* ({ serviceId, service, tool }) {
        if (tool.effect !== 'write') return tool.effect
        const key = new CacheKey({
          serviceId,
          service,
          tool: tool.name,
          description: tool.description,
          descriptionHash: NodeCrypto.createHash('sha256').update(tool.description).digest('hex'),
        })
        return yield* Cache.get(cache, key).pipe(
          Effect.catch(() => Effect.succeed<typeof ExecutorTool.Type.effect>('write')),
        )
      }),
    })
  }),
)

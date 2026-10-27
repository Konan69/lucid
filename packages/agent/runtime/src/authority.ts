import type { Harness } from '@earendil-works/pi-durable'
import { VividRpcClient } from '@vivid/client-runtime'
import { Effect, Layer, Option } from 'effect'
import { NobodyToActFor, type ProductService } from './client.ts'
import { answering } from './deliveries.ts'
import { recoverAuthority, resolveAuthority, type DeliveryAuthority } from './delivery.ts'
import { threadOf } from './threads.ts'
import type { ToolFailure } from './tools/result.ts'
import { Scope, type ResolveScope } from './tools/scope.ts'

const nobody = (message: string) => new NobodyToActFor({ message })

/** A tool acts for the Person behind the newest input its run placed (`answering`). Private
 * messages use the recorded creator. Signals use admission scope, recovered through
 * `GetDeliveryScope` after a restart. Nothing in model arguments supplies authority.
 * The attributed Layer lasts for the call; the bare client lasts for the recovery lookup. */
export const scopeResolver =
  (harness: Effect.Effect<Harness>, product: ProductService): ResolveScope =>
  (call) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const authority = yield* resolveCall(harness, product, call)
        return Layer.effect(
          Scope,
          Effect.gen(function* () {
            return Scope.of({ acting: authority.acting, client: yield* VividRpcClient })
          }),
        ).pipe(Layer.provide(product.as(authority.acting)))
      }),
    )

/** Resolve delivery authority without acquiring the product client, so local notes survive a server outage. */
export const resolveCall: (
  harness: Effect.Effect<Harness>,
  product: ProductService,
  call: Parameters<ResolveScope>[0],
) => Effect.Effect<DeliveryAuthority, ToolFailure> = Effect.fn('Authority.resolveCall')(
  function* (
    harness: Effect.Effect<Harness>,
    product: ProductService,
    call: Parameters<ResolveScope>[0],
  ) {
    const opened = yield* harness
    const thread = yield* threadOf(opened, call.conversationId)
    const delivery = yield* answering(opened, call.conversationId)
    if (Option.isNone(thread) || Option.isNone(delivery))
      return yield* nobody('There is no Person behind this message to act for.')
    const { threadId, creator, creatorName } = thread.value
    const authority = yield* resolveAuthority(
      threadId,
      delivery.value.addressed,
      Option.some({ creator, creatorName }),
      (recovered, turn) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(product.bare)
            return yield* recoverAuthority(recovered, turn).pipe(Effect.provide(context))
          }),
        ),
    )
    return authority
  },
  (effect) =>
    effect.pipe(
      // A store that cannot be read names nobody; the call fails and nothing is done.
      Effect.catchTag('PiRejected', () =>
        Effect.fail(nobody('The conversation could not be read to find who this is for.')),
      ),
    ),
)

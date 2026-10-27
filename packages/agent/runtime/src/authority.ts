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

/**
 * Whom one tool call acts for. The rule is main's, unchanged: a tool acts for the Person behind
 * the delivery being answered; a private message is from the Thread's creator, recorded when the
 * conversation was created; a signal is found by its turn in the record made at admission, or,
 * when this process no longer has it (a restart in the middle of a response), from the server
 * with the bare runtime credential (`GetDeliveryScope`).
 *
 * What changed is where "the delivery being answered" comes from. Flue handed it to the render;
 * here it is read from the conversation: the newest input its current run has placed
 * (`deliveries.ts` `answering`). Pi gives a tool only its own ids, so the Thread is read from the
 * conversation's own record and nothing is taken from the call's arguments.
 *
 * The attributed client lives as long as the returned Layer, which the tool boundary holds for
 * the whole call. The bare client lives only for the one lookup, in a scope of its own.
 */
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

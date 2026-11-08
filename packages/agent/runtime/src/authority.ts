import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { LiveDoc, type Harness, type SubmissionId } from '@earendil-works/pi-durable'
import {
  MemoryAuthority,
  MemoryCitation,
  MemorySource,
  MemoryTaskId,
  MessageId,
  type RunId,
} from '@vivid/contracts'
import { VividRpcClient } from '@vivid/client-runtime'
import { Effect, Layer, Option } from 'effect'
import { NobodyToActFor, type ProductService } from './client.ts'
import { answering } from './deliveries.ts'
import { helperOf } from './helper.ts'
import { recoverAuthority, resolveAuthority, type DeliveryAuthority } from './delivery.ts'
import { pi, threadOf } from './threads.ts'
import { learnerAuthority } from './learning.ts'
import type { MemoryWriter } from './memory.ts'
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
            return Scope.of({
              acting: authority.acting,
              client: yield* VividRpcClient,
              timezone: authority.timezone,
            })
          }),
        ).pipe(
          Layer.provide(
            Option.match(authority.helper, {
              onNone: () => product.as(authority.acting),
              onSome: (helper) => product.asHelper(authority.acting, helper),
            }),
          ),
        )
      }),
    )

/**
 * The delivery's authority plus the time zone frozen with the response being answered. `helper`
 * names the helper Run when the call comes from a helper's conversation (`helper.ts`).
 */
interface CallAuthority extends DeliveryAuthority {
  readonly timezone: string
  readonly helper: Option.Option<RunId>
}

/** Resolve delivery authority without acquiring the product client, so local memory survives a server outage. */
export const resolveCall: (
  harness: Effect.Effect<Harness>,
  product: ProductService,
  call: Parameters<ResolveScope>[0],
) => Effect.Effect<CallAuthority, ToolFailure> = Effect.fn('Authority.resolveCall')(
  function* (
    harness: Effect.Effect<Harness>,
    product: ProductService,
    call: Parameters<ResolveScope>[0],
  ) {
    const opened = yield* harness
    // A helper acts for the Person its parent Run acts for, as itself; it has no delivery.
    const helper = yield* helperOf(opened, call.conversationId)
    if (Option.isSome(helper))
      return {
        acting: helper.value.acting,
        timezone: helper.value.timezone,
        helper: Option.some(helper.value.runId),
      }
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
    return {
      acting: authority.acting,
      timezone: delivery.value.context.timezone,
      helper: Option.none(),
    }
  },
  (effect) =>
    effect.pipe(
      // A store that cannot be read names nobody; the call fails and nothing is done.
      Effect.catchTag('PiRejected', () =>
        Effect.fail(nobody('The conversation could not be read to find who this is for.')),
      ),
    ),
)

/** Source the native Run from Pi's committed live document, not the model or the tool task id. */
export const resolveMemoryCall: (
  harness: Effect.Effect<Harness>,
  product: ProductService,
  call: Parameters<ResolveScope>[0],
) => Effect.Effect<MemoryWriter, ToolFailure> = Effect.fn('Authority.resolveMemoryCall')(
  function* (harness, product, call) {
    const learning = yield* learnerAuthority(yield* harness, call.conversationId).pipe(
      Effect.mapError(() => nobody('The learning authority could not be read.')),
    )
    if (Option.isSome(learning)) return learning.value
    const { acting } = yield* resolveCall(harness, product, call)
    const opened = yield* harness
    const live = yield* pi(() =>
      opened.snapshot(LiveDoc, call.conversationId, BACKGROUND_CONTEXT),
    ).pipe(Effect.mapError(() => nobody('The source Run could not be read.')))
    if (live === undefined || live.run === undefined)
      return yield* nobody('There is no active Run behind this memory call.')
    const source = MemorySource.cases.ThreadRun.make({
      threadId: acting.threadId,
      taskId: MemoryTaskId.make(live.run.taskId),
    })
    const said = yield* inputMessages(opened, live.run.inputs).pipe(
      Effect.mapError(() => nobody('The messages behind this Run could not be read.')),
    )
    return {
      authority: MemoryAuthority.make({ actor: acting.personId, source }),
      citations: [
        MemoryCitation.cases.Run.make({ source }),
        ...said.map((messageId) =>
          MemoryCitation.cases.ThreadMessage.make({ threadId: acting.threadId, messageId }),
        ),
      ],
    }
  },
)

/**
 * The messages this Run answers: each input's transcript entry, named as the conversation names
 * a Person's message (`entry-<n>`, `state/project.ts` `personMessage`). An input not yet placed in
 * the transcript has no message and is left out; the Run citation stands for it.
 */
const inputMessages = Effect.fn('Authority.inputMessages')(function* (
  harness: Harness,
  inputs: ReadonlyArray<SubmissionId>,
) {
  const entries = yield* Effect.forEach(inputs, (id) => placedEntry(harness, id))
  return entries.flatMap((entry) =>
    Option.toArray(Option.map(entry, (id) => MessageId.make(`entry-${id}`))),
  )
})

/** The transcript entry one input was placed at, once it is placed. */
const placedEntry = Effect.fn('Authority.placedEntry')(function* (
  harness: Harness,
  id: SubmissionId,
) {
  const submission = yield* pi(() => harness.submission(id, BACKGROUND_CONTEXT))
  if (submission === undefined) return Option.none<number>()
  const record = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
  return record.type === 'input' && record.entry !== undefined
    ? Option.some<number>(record.entry)
    : Option.none<number>()
})

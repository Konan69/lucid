import { describe, expect, it } from '@effect/vitest'
import { ServiceUnavailable } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { chainFixture, chainLayer, completeRun, replyText, toolParts } from '../runtime/chains.ts'

/** What a tool hands the model when the part of Vivid behind it is not answering. */
const decodeRefusal = Schema.decodeUnknownEffect(
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
)

/**
 * Memory not answering, through the real server, runtime and model.
 *
 * The stack this runs against has its memory service configured (a server does not start
 * otherwise) at an address that does not answer: the hosted Helix is on a private network a
 * developer's machine cannot reach. Nothing is stopped or broken to stage the outage.
 *
 * The claim is that an outage is a failure of the call that met it and of nothing else: the
 * Person's own memory call is refused with the typed failure, Vivid is told the same thing when
 * it looks something up and says so plainly, and the rest of the product keeps answering.
 */
describe.skipIf(process.env['VIVID_LIVE_MEMORY_OUTAGE'] !== '1')('Memory outage live chain', () => {
  it.live(
    'refuses the memory call, tells the Person through Vivid, and keeps serving everything else',
    () =>
      Effect.gen(function* () {
        const fixture = yield* chainFixture('Memory outage proof')

        const refused = yield* fixture.rpc.Recall({ query: 'travel plans' }).pipe(Effect.flip)
        expect(refused).toBeInstanceOf(ServiceUnavailable)
        expect(refused).toHaveProperty('service', 'memory')
        // The same Person's other calls are answered by the same server at the same moment.
        expect(
          (yield* fixture.rpc.ListThreads()).threads.some(
            (thread) => thread.id === fixture.threadId,
          ),
        ).toBe(true)

        const runId = yield* fixture.send(
          'Call recall to search your knowledge base for my travel plans. Do it now, then tell me in one sentence exactly what happened.',
        )
        const state = yield* completeRun(fixture, runId)
        const recalls = toolParts(state).filter((part) => part.toolName === 'recall')
        expect(recalls.length).toBeGreaterThan(0)
        // The model is told only that this part is not available right now: no address, no cause.
        // The tool's own answer is decoded, so words the model wrote into its input cannot pass
        // for the refusal, and a recall that succeeded cannot pass at all.
        for (const part of recalls) {
          if (part.state !== 'output-available')
            return yield* Effect.sync(() => expect.fail('The recall must settle with an answer'))
          expect(yield* decodeRefusal(part.output)).toEqual({
            ok: false,
            message: 'That part of Vivid is not available right now.',
          })
          expect(JSON.stringify(part.output)).not.toMatch(/helix|railway|ECONN|ENOTFOUND/iu)
        }
        // Vivid says that it could not look, not that it looked and found nothing.
        expect(replyText(state)).toMatch(
          /not available|unavailable|isn.t (available|working|responding|answering)|can.t (reach|access|search|check)|couldn.t (reach|access|search|check|complete)|unable to/iu,
        )
        expect(replyText(state)).not.toMatch(/no (travel )?plans|nothing (saved|stored|about)/iu)
      }).pipe(Effect.scoped, Effect.provide(chainLayer)),
    { timeout: 180_000 },
  )
})

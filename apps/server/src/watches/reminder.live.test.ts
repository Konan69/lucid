import * as NodeFS from 'node:fs'
import { describe, expect, layer } from '@effect/vitest'
import { FeedItem } from '@vivid/contracts'
import { Duration, Effect, Option, Schema, Stream } from 'effect'
import { chainFixture, chainLayer, completeRun, replyText, toolParts } from '../runtime/chains.ts'

/**
 * A reminder asked for in plain words, on the real stack: Vivid makes an Integration of its own
 * (`make_integration`, an Executor app that waits for the time and emits an event), watches that
 * event, sets the reminder, and when the time comes the reminder reaches the Person's Feed from a
 * background Thread. Nothing here is scripted: the model decides every step from its skill.
 *
 * Needs the running stack (`runtime/chains.ts`) on a public HTTPS `PUBLIC_URL` and an Executor at
 * 2.0.0-beta.23 named by the `VIVID_EXECUTOR_*` settings.
 */

const toolNames = (state: Parameters<typeof toolParts>[0]) =>
  toolParts(state).map((part) => `${part.toolName}:${part.state}`)

/** A `use_tool` call as the model made it, and the receipt the made app answered with. */
// `use_tool` takes its input as an object or as JSON text (`runtime/src/tools/connections.ts`).
const UseTool = Schema.Struct({
  tool: Schema.String,
  input: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)]),
})
/** What Vivid asked the made app for, when it gave a delay rather than a clock time. */
const After = Schema.Struct({ minutes: Schema.Finite })
const afterFromText = Schema.decodeUnknownOption(Schema.fromJsonString(After))
const afterFromObject = Schema.decodeUnknownOption(After)
const decodeAfter = (input: typeof UseTool.Type.input) =>
  Option.orElse(afterFromText(input), () => afterFromObject(input))
const Receipt = Schema.Struct({
  ok: Schema.Literal(true),
  output: Schema.Struct({ at: Schema.String }),
})
const decodeUseTool = Schema.decodeUnknownOption(UseTool)
const decodeReceipt = Schema.decodeUnknownOption(Receipt)

/** When a Feed item last moved: for a reminder's card, when it was put on the Feed. */
const movedAt = (item: FeedItem) =>
  FeedItem.match(item, {
    Working: ({ since }) => since,
    Waiting: ({ at }) => at,
    Settled: ({ at }) => at,
  })

describe.skipIf(process.env['VIVID_LIVE_REMINDER'] !== '1')('Reminder live chain', () => {
  layer(chainLayer, { excludeTestServices: true, timeout: 600_000 })((test) => {
    test.effect(
      'a reminder Vivid sets for itself reaches the Feed at its time',
      () =>
        Effect.gen(function* () {
          const fixture = yield* chainFixture('Reminder proof')
          const sentAt = Date.now()
          const asked = yield* fixture.send(
            'Remind me in two minutes to stretch my legs. My time zone is Africa/Lagos.',
          )
          const state = yield* completeRun(fixture, asked)
          const settledAt = Date.now()
          const steps = toolNames(state)
          // Vitest hides a passing test's output; the trail is kept where the runner asks for it.
          const trail = process.env['VIVID_PROOF_TRAIL']
          if (trail !== undefined)
            NodeFS.writeFileSync(
              trail,
              JSON.stringify({ reply: replyText(state), tools: toolParts(state) }, null, 2),
            )
          // The trail is the evidence of what Vivid chose to do; it is printed on failure.
          expect(steps, replyText(state)).toContain('make_integration:output-available')
          expect(steps, replyText(state)).toContain('watch:output-available')
          expect(steps, replyText(state)).toContain('use_tool:output-available')
          // The reminder was set through the made app, for about two minutes from the ask, and
          // its event was not fired by hand.
          const calls = toolParts(state).filter(
            (part) => part.toolName === 'use_tool' && part.state === 'output-available',
          )
          const called = calls.map((part) =>
            Option.match(decodeUseTool(part.input), {
              onNone: () => '',
              onSome: ({ tool }) => tool,
            }),
          )
          expect(called, replyText(state)).not.toContain('ring')
          const set = calls.find((part) =>
            Option.exists(decodeUseTool(part.input), ({ tool }) => tool.startsWith('remind')),
          )
          if (set === undefined || set.state !== 'output-available')
            return yield* Effect.sync(() => expect.fail('Vivid must set the reminder'))
          const receipt = decodeReceipt(set.output)
          if (Option.isNone(receipt))
            return yield* Effect.sync(() => expect.fail('The reminder must be accepted'))
          const due = Date.parse(receipt.value.output.at)
          // Asked as a delay, it must be the two minutes the Person said.
          const requested = Option.flatMap(decodeUseTool(set.input), (call) =>
            call.tool === 'remindIn' ? decodeAfter(call.input) : Option.none(),
          )
          if (Option.isSome(requested)) expect(requested.value.minutes).toBe(2)
          // Two minutes from when Vivid set it, which is some time inside its Run.
          expect(due).toBeGreaterThanOrEqual(sentAt + 115_000)
          expect(due).toBeLessThanOrEqual(settledAt + 125_000)

          const watches = (yield* fixture.rpc.ListWatches()).watches
          expect(watches.length).toBeGreaterThan(0)
          yield* Effect.addFinalizer(() =>
            Effect.forEach(watches, (watch) => fixture.rpc.StopWatch({ name: watch.name })).pipe(
              Effect.catch(() => Effect.sync(() => expect.fail('Reminder watch stop failed'))),
            ),
          )

          // The reminder arrives on its own about two minutes later; the Feed is read live.
          const arrived = yield* fixture.rpc.WatchFeed().pipe(
            Stream.filter((feed) =>
              feed.items.some(
                (item) =>
                  item.thread.startsWith('watch-') &&
                  item.post !== null &&
                  (FeedItem.guards.Waiting(item) || FeedItem.guards.Settled(item)),
              ),
            ),
            Stream.runHead,
            Effect.timeout(Duration.minutes(6)),
          )
          if (Option.isNone(arrived))
            return yield* Effect.sync(() => expect.fail('The Feed stream ended'))
          const [card] = arrived.value.items.filter((item) => item.thread.startsWith('watch-'))
          if (card === undefined || card.post === null)
            return yield* Effect.sync(() => expect.fail('The reminder must reach the Feed'))
          expect(JSON.stringify(card.post)).toMatch(/stretch/i)
          // It reached the Feed at its time, not before (a little clock slack between services).
          expect(movedAt(card)).toBeGreaterThanOrEqual(due - 2_000)
        }).pipe(Effect.scoped),
      { timeout: 600_000 },
    )
  })
})

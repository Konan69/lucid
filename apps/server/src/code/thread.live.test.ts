import { describe, expect, it } from '@effect/vitest'
import { CodeCall } from '@vivid/contracts'
import { Effect, Option, Schema, Layer } from 'effect'
import { chainFixture, chainLayer, completeRun, toolParts } from '../runtime/chains.ts'

/** What `run_code` hands the model when a program ran to its end. */
const Ran = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Json,
  calls: Schema.Array(CodeCall),
})
const decodeRan = Schema.decodeUnknownEffect(Ran)

/**
 * One real request, one real model turn: Vivid writes a program from the description of the
 * language it is given, the server interprets it, and the program's two calls are checked and
 * answered as the Person. Public pages only: no account and nothing changed outside.
 *
 * What this shows that the supervised tests cannot: that a real model, reading only the tool's
 * description, writes a program the interpreter accepts, and that the result reaches the Thread.
 */
describe.skipIf(process.env['VIVID_LIVE_THREAD_PROGRAM'] !== '1')(
  'Thread program live chain',
  () => {
    it.live(
      'a program Vivid writes is interpreted on the server and has its calls answered',
      () =>
        Effect.gen(function* () {
          const caseContext = yield* Layer.build(chainLayer)
          return yield* Effect.gen(function* () {
            const fixture = yield* chainFixture('Program chain proof')
            const runId = yield* fixture.send(
              'Do this with one run_code program and nothing else. In the program: read https://example.com/ and https://www.iana.org/help/example-domains with tools.read_page, both at the same time, and return an array of the two page titles sorted by length, shortest first. Afterwards tell me the titles.',
            )
            const state = yield* completeRun(fixture, runId)
            const programs = toolParts(state).filter((part) => part.toolName === 'run_code')
            const finished = programs.filter((part) => part.state === 'output-available')
            expect(finished.length, 'The model must have run a program').toBeGreaterThan(0)
            const outputs = yield* Effect.forEach(finished, (part) =>
              part.state === 'output-available'
                ? decodeRan(part.output).pipe(Effect.option)
                : Effect.succeedNone,
            )
            const ran = outputs.flatMap(Option.toArray)
            expect(ran.length, 'A program must have run to its end').toBeGreaterThan(0)
            const pages = ran.flatMap((program) =>
              program.calls.filter((call) => call.kind === 'read_page' && call.end === 'completed'),
            )
            expect(pages.length, 'The program’s two page reads must both be answered').toBe(2)
            // The title of the first page, as the server's own reader returned it to the program.
            expect(JSON.stringify(ran.map((program) => program.result))).toContain('Example Domain')
          }).pipe(Effect.scoped, Effect.provide(caseContext))
        }).pipe(Effect.scoped),
      { timeout: 300_000 },
    )
  },
)

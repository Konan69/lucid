import { describe, expect, it } from '@effect/vitest'
import { ComputerSession, computerScreenAddress } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import {
  chainFixture,
  chainLayer,
  chainStanding,
  completeRun,
  replyText,
  toolParts,
  waitForState,
} from '../runtime/chains.ts'
import { bindings } from './boat/bindings.ts'
import { computerMachineKey } from './store.ts'

const Input = Schema.Struct({
  summary: Schema.NonEmptyString,
  action: Schema.Struct({ kind: Schema.String }),
})
const Output = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ outline: Schema.String }),
  computer: ComputerSession,
})
const Typed = Schema.Struct({
  action: Schema.Struct({ kind: Schema.Literal('type'), text: Schema.String }),
})

const decodeInput = Schema.decodeUnknownEffect(Input)
const decodeOutput = Schema.decodeUnknownEffect(Output)
const typedInput = Schema.decodeUnknownOption(Typed)

/**
 * The machine in this proof is not a fixture. It is the standing proof account's own Computer,
 * which exists before the proof and must exist after it, so nothing here creates a machine and
 * nothing deletes one: an earlier version deleted whatever machine the Person was bound to, which
 * would have destroyed the one prepared machine the moment a proof ran against it.
 *
 * The proof wakes the Computer through the Thread and, when it is over, turns it off through the
 * product's own `StopComputer`, which archives the machine with its files and sign-ins kept.
 */
const restComputer = Effect.fn('ThreadProof.restComputer')(function* (
  rpc: Effect.Success<ReturnType<typeof chainStanding>>['rpc'],
) {
  yield* Effect.addFinalizer(() =>
    rpc.StopComputer().pipe(
      Effect.asVoid,
      Effect.catch(() =>
        Effect.sync(() => expect.fail('The proof could not turn the Computer off again')),
      ),
    ),
  )
})

/** One real Thread request drives Boat browser input and desktop sight. Public Selenium input
 * has no account or external side effects, and no model judge or retry consumes extra calls.
 */
describe.skipIf(process.env['VIVID_LIVE_THREAD_COMPUTER'] !== '1')(
  'Thread Computer live chain',
  () => {
    it.live(
      'wakes Boat, types, clicks, reads and streams its scoped session receipt',
      () =>
        Effect.gen(function* () {
          const fixture = yield* chainStanding('Computer chain proof')
          // The account must already have its machine: a proof that had one made would be the
          // very thing this proof is not allowed to do.
          expect(
            (yield* (yield* bindings()).load(computerMachineKey(fixture.personId)))._tag,
            'The standing proof account has no Computer binding; do not run this proof without one',
          ).toBe('Some')
          yield* restComputer(fixture.rpc)
          const runId = yield* fixture.send(
            'Use your Computer browser, not read_page or run_code, to open https://www.selenium.dev/selenium/web/web-form.html. Type "Vivid chain verified" in Text input, read it back, click Submit, then read the resulting page. Call use_desktop to see the final screen. Tell me the confirmation shown. Use browse directly for every browser step.',
          )
          const running = yield* waitForState(fixture.conversation, (state) =>
            toolParts(state).some(
              (part) => part.toolName === 'browse' && part.state === 'input-available',
            ),
          )
          const step = toolParts(running).find(
            (part) => part.toolName === 'browse' && part.state === 'input-available',
          )
          if (step === undefined)
            return yield* Effect.sync(() => expect.fail('The Thread must publish the running tool'))
          const input = yield* decodeInput(step.input)
          expect(input.summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i)
          const state = yield* completeRun(fixture, runId)
          const receipts = toolParts(state).filter(
            (part) => part.toolName === 'browse' && part.state === 'output-available',
          )
          const actions = yield* Effect.forEach(receipts, (part) => decodeInput(part.input))
          expect(actions.map((value) => value.action.kind)).toEqual(
            expect.arrayContaining(['open', 'type', 'click', 'read']),
          )
          expect(
            receipts.some((part) =>
              Option.exists(
                typedInput(part.input),
                (value) => value.action.text === 'Vivid chain verified',
              ),
            ),
          ).toBe(true)
          const observations: string[] = []
          for (const part of receipts) {
            if (part.state !== 'output-available') continue
            const result = yield* decodeOutput(part.output)
            observations.push(result.result.outline)
            expect(result.computer.screen.address).toBe(computerScreenAddress)
            expect(JSON.stringify(result.computer)).not.toContain(fixture.personId)
          }
          expect(
            observations.some((outline) => outline.includes('Vivid chain verified')),
            'A provider receipt must verify the entered value',
          ).toBe(true)
          expect(
            observations.some((outline) => /received/i.test(outline)),
            'The submitted page must show a real confirmation',
          ).toBe(true)
          expect(
            toolParts(state).some(
              (part) => part.toolName === 'use_desktop' && part.state === 'output-available',
            ),
          ).toBe(true)
          expect(replyText(state)).toMatch(/received/i)
          expect((yield* (yield* bindings()).load(computerMachineKey(fixture.personId)))._tag).toBe(
            'Some',
          )
          const other = yield* chainFixture('Computer isolation proof')
          expect((yield* other.rpc.GetComputer()).computer.state._tag).toBe('Absent')
        }).pipe(Effect.scoped, Effect.provide(chainLayer)),
      { timeout: 240_000 },
    )
  },
)

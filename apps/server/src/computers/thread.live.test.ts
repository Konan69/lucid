import { describe, expect, it } from '@effect/vitest'
import { ComputerSession, computerScreenAddress } from '@vivid/contracts'
import { Config, Effect, Option, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { Database } from '../database/client.ts'
import {
  chainFixture,
  chainLayer,
  completeRun,
  replyText,
  toolParts,
  waitForState,
} from '../runtime/chains.ts'
import { bindings } from './boat/bindings.ts'
import { computerMachineKey } from './store.ts'
import { machineBindings } from './tables.ts'

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

/** Only this fixture's captured Machine key grants cleanup authority; no resource inventory or
 * process pattern is used. Cleanup is registered before the first Computer tool can create it.
 */
const cleanupComputer = Effect.fn('ThreadProof.cleanupComputer')(function* (
  person: Parameters<typeof computerMachineKey>[0],
) {
  const key = computerMachineKey(person)
  const saved = yield* bindings()
  const database = yield* Database
  const http = yield* HttpClient.HttpClient
  const apiKey = yield* Config.Redacted('VIVID_BOAT_API_KEY')
  // An installation that names its existing machine (`VIVID_BOAT_MACHINE`) had this Person take
  // that machine; it was not created here and is not this test's to delete. Until 5 October 2026
  // this finalizer deleted whatever was bound, which with that setting is the only machine.
  const adopted = yield* Config.option(Config.String('VIVID_BOAT_MACHINE'))
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const binding = yield* saved.load(key)
      if (
        Option.isSome(binding) &&
        binding.value.providerId !== null &&
        !Option.contains(adopted, binding.value.providerId)
      ) {
        const id = binding.value.providerId
        const response = yield* http.execute(
          HttpClientRequest.delete(`https://boat.dev/api/v1/sandboxes/${id}`).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeader('X-Ascii-Confirm-Delete', id),
          ),
        )
        expect(response.status >= 200 && response.status < 300).toBe(true)
      }
      yield* database.run(database.delete(machineBindings).where(eq(machineBindings.key, key)))
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => expect.fail('Boat fixture cleanup failed; reconcile the test machine')),
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
          expect(
            yield* Config.NonEmptyString('VIVID_COMPUTER_PROVIDER'),
            'Restart the night server with the Boat provider',
          ).toBe('boat')
          const fixture = yield* chainFixture('Computer chain proof')
          yield* cleanupComputer(fixture.personId)
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

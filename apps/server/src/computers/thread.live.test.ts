import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { ComputerSession, ScreenPoint, computerScreenAddress } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import {
  chainFixture,
  type ChainFixture,
  chainLayer,
  completeRun,
  replyText,
  toolParts,
  waitForState,
} from '../runtime/chains.ts'
import { bindings } from './boat/bindings.ts'
import { proofComputer, proofProvider } from './tests/proof.ts'
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
// Browse results without a picture project as their single JSON text block.
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(Output))
const typedInput = Schema.decodeUnknownOption(Typed)

/** The expected screenshot receipt names its PNG attachment beside native tool metadata. */
const DesktopReceipt = Schema.Tuple([
  Schema.Struct({
    type: Schema.Literal('text'),
    text: Schema.fromJsonString(
      Schema.Struct({
        ok: Schema.Literal(true),
        view: Schema.Struct({
          width: Schema.Int.check(Schema.isGreaterThan(0)),
          height: Schema.Int.check(Schema.isGreaterThan(0)),
          pointer: ScreenPoint,
          window: Schema.NullOr(Schema.String),
        }),
        computer: ComputerSession,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('attachment'),
    attachment: Schema.Struct({
      id: Schema.NonEmptyString,
      mimeType: Schema.Literal('image/png'),
      size: Schema.Int.check(Schema.isGreaterThan(0)),
      digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    }),
  }),
])
const decodeDesktop = Schema.decodeUnknownEffect(DesktopReceipt)

/** Fetch the receipt's attachment through the public, cookie-authenticated gateway.
 * Size, digest and PNG structure prove the receipt names complete image bytes. */
const desktopPicture = Effect.fn('ThreadProof.desktopPicture')(function* (
  fixture: ChainFixture,
  receipt: typeof DesktopReceipt.Type,
) {
  const [metadata, image] = receipt
  expect(metadata.text.computer.screen.address).toBe(computerScreenAddress)
  expect(JSON.stringify(metadata.text.computer)).not.toContain(fixture.personId)
  const address = new URL(fixture.conversation.attachmentUrl(image.attachment.id))
  expect(address.origin).toBe(fixture.server.origin)
  const response = yield* (yield* HttpClient.HttpClient).execute(
    HttpClientRequest.get(address).pipe(HttpClientRequest.setHeader('cookie', fixture.cookie)),
  )
  expect(response.status).toBe(200)
  expect(response.headers['content-type']).toMatch(/^image\/png(?:;|$)/u)
  const picture = Buffer.from(yield* response.arrayBuffer)
  expect(picture.byteLength).toBe(image.attachment.size)
  expect(NodeCrypto.createHash('sha256').update(picture).digest('hex')).toBe(
    image.attachment.digest,
  )
  expect([...picture.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(picture.subarray(12, 16).toString('ascii')).toBe('IHDR')
  expect([picture.readUInt32BE(16), picture.readUInt32BE(20)]).toEqual([
    metadata.text.view.width,
    metadata.text.view.height,
  ])
  expect([...picture.subarray(-12)]).toEqual([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
})

/** One real Thread request drives Boat browser input and desktop sight. Public Selenium input
 * has no account or external side effects, and no model judge or retry consumes extra calls.
 */
/** Opt-in work has no progress-aware in-test bound yet. Retain the existing runner
 * overrides until that migration. Source: unmeasured existing allocations. */
describe.skipIf(process.env['VIVID_LIVE_THREAD_COMPUTER'] !== '1')(
  'Thread Computer live chain',
  () => {
    layer(chainLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
      it.effect(
        'wakes Boat, types, clicks, reads and streams its scoped session receipt',
        () =>
          Effect.gen(function* () {
            yield* proofProvider()
            const fixture = yield* chainFixture('Computer chain proof')
            const owned = yield* proofComputer(computerMachineKey(fixture.personId))
            // The real Thread must wake the captured resource, not an existing Person Computer.
            yield* owned.machine.stop(owned.key)
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
              return yield* Effect.sync(() =>
                expect.fail('The Thread must publish the running tool'),
              )
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
            const desktop = toolParts(state).find(
              (part) => part.toolName === 'use_desktop' && part.state === 'output-available',
            )
            if (desktop === undefined || desktop.state !== 'output-available')
              return yield* Effect.sync(() =>
                expect.fail('The Thread must return its desktop picture'),
              )
            yield* desktopPicture(fixture, yield* decodeDesktop(desktop.output))
            expect(replyText(state)).toMatch(/received/i)
            expect(
              (yield* (yield* bindings()).load(computerMachineKey(fixture.personId)))._tag,
            ).toBe('Some')
            const other = yield* chainFixture('Computer isolation proof')
            expect((yield* other.rpc.GetComputer()).computer.state._tag).toBe('Absent')
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    })
  },
)

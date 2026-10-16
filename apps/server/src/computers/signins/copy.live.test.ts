import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { CopySignInOutcome } from '@vivid/contracts'
import { Config, Effect, Option, Schema } from 'effect'
import { chainSession, completeRun, toolParts } from '../../runtime/chains.ts'

const SITE = 'httpbin.org'
const VALUE = 'synthetic-copy-proof'
const copied = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Literal(true),
    site: Schema.Literal(SITE),
    outcome: CopySignInOutcome.cases.Copied,
  }),
)
const page = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({ address: Schema.String, outline: Schema.String }),
  }),
)

/** Full desktop consent → device link → Computer proof. The operator supplies a real desktop
 * app signed into this server and an isolated Chrome Default profile containing exactly one
 * SYNTHETIC cookie: __Host-vivid-signin-proof-<VIVID_LIVE_SIGNIN_MARKER>, value above, host
 * httpbin.org, path /, Secure and HttpOnly. Never use an installed personal browser profile.
 * Approve the real native dialog on the Cloudbox virtual display while this test waits.
 * VIVID_LIVE_SIGNIN_COOKIE authenticates the existing Person; it is never printed.
 * The marker is twelve public hex characters, not an account credential. The echo page can
 * therefore prove delivery without putting any real sign-in value into the model or logs.
 * The operator registers deletion of this exact named cookie and Computer restoration before
 * starting; all app/runtime/database fixtures live on Cloudbox, never on the Computer. */
describe.skipIf(process.env['VIVID_LIVE_SIGNIN_COPY'] !== '1')('sign-in copy, live', () => {
  layer(NodeHttpClient.layerUndici, { excludeTestServices: true, timeout: 300_000 })((it) => {
    it.effect(
      'copies the consented synthetic site cookie and the Computer sends it to that site',
      () =>
        Effect.gen(function* () {
          const marker = yield* Config.NonEmptyString('VIVID_LIVE_SIGNIN_MARKER')
          expect(marker).toMatch(/^[0-9a-f]{12}$/u)
          const name = `__Host-vivid-signin-proof-${marker}`
          const fixture = yield* chainSession(
            yield* Config.Redacted('VIVID_LIVE_SIGNIN_COOKIE'),
            'Sign-in copy proof',
          )
          const copying = yield* fixture.send(
            `Copy my ${SITE} sign-in from Chrome, profile Default, to Vivid’s Computer. I will approve the desktop dialog. Use copy_signin once; reply with the transfer result and wait. This isolated profile contains only one synthetic proof cookie.`,
          )
          const read = toolParts(yield* completeRun(fixture, copying)).flatMap((part) => {
            if (part.toolName !== 'copy_signin' || part.state !== 'output-available') return []
            const receipt = copied(part.output)
            return Option.isSome(receipt) ? [receipt.value] : []
          })
          expect(read).toHaveLength(1)
          expect(read.map((receipt) => receipt.outcome.cookies)).toEqual([1])
          const address = new URL(`https://${SITE}/cookies`)
          address.searchParams.set('vivid-proof', marker)
          const opening = yield* fixture.send(
            `Navigate the current browser tab on Vivid’s Computer to ${address.href}. Read this synthetic proof page, then reply done.`,
          )
          const receipts = toolParts(yield* completeRun(fixture, opening)).flatMap((part) => {
            if (part.toolName !== 'browse' || part.state !== 'output-available') return []
            const receipt = page(part.output)
            return Option.isSome(receipt) && receipt.value.result.address === address.href
              ? [receipt.value.result.outline]
              : []
          })
          expect(
            receipts.some((outline) => outline.includes(name) && outline.includes(VALUE)),
          ).toBe(true)
        }).pipe(Effect.scoped),
      { timeout: 600_000 },
    )
  })
})

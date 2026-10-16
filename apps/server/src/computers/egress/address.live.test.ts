import * as NodeCrypto from 'node:crypto'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import type { FlueConversationState } from '@flue/sdk'
import { ComputerState, EgressStatus, PatchSettingsRequest } from '@vivid/contracts'
import { Array as Arr, Config, Effect, Option, Schema, Stream } from 'effect'
import { type ChainFixture, chainSession, completeRun, toolParts } from '../../runtime/chains.ts'

/**
 * Egress on a real Computer with a real desktop app: a page opened in the Computer's browser
 * sees the address of the Person's own computer, and not the Computer's.
 *
 * What it needs, all supplied by whoever runs it:
 *
 * - `VIVID_LIVE_EGRESS=1`.
 * - `VIVID_SERVER_URL` and `PUBLIC_URL`: a running Vivid server with a real model.
 * - `VIVID_LIVE_EGRESS_COOKIE`: the session cookie of a Person of that server whose desktop app
 *   (a build with egress) is open and signed in as them, on a network other than the
 *   Computer's. The cookie is read redacted and never printed.
 * - `VIVID_LIVE_EGRESS_ADDRESS` (optional): that computer's public address, when it is known.
 *   The address the page saw with egress on must then be exactly it. Give it whenever it can
 *   be found: without it the proof shows two different ways out, and not whose the first is.
 *
 * What it does to that Person's account: it turns egress on and, at the end, off again; it stops
 * and starts their Computer, so that the browser is started after egress was turned on (a
 * browser keeps the way out it started with); and it leaves one Thread, "Egress proof".
 *
 * The page is opened by Vivid, in a real Run, because that is the only thing that opens a page
 * in the Computer's browser. The echo page is opened twice, each time at a new address: with egress on, and with it off,
 * when the Computer's proxy goes out from the Computer itself.
 *
 * What is compared is what the browser itself returned, never what Vivid said about it: each
 * step in the Computer's browser leaves a receipt in the Thread (the `browse` tool's output:
 * the page's address and its outline, as the browser gave them to the server), and the address
 * is read out of the outline of the receipt for the echo page. A Run in which the browser did
 * nothing leaves no such receipt and fails the proof, whatever the reply says; an earlier
 * version read the reply and passed on any two different answers. It is not run by the gate;
 * run it with Vitest directly.
 */
const ECHO = 'https://api.ipify.org'

/** An IPv4 or IPv6 address somewhere in a page's outline. */
const ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/iu

/**
 * A browser step's receipt as the Thread holds it: a native Browse result with no picture is
 * its single JSON text block in Flue 2.2.2 (`computers/thread.live.test.ts`).
 */
const Receipt = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({ address: Schema.String, outline: Schema.String }),
  }),
)
const decodeReceipt = Schema.decodeUnknownOption(Receipt)

/**
 * The address the echo page showed in each receipt the Computer's browser left for it, oldest
 * first. A receipt for another page, a refused step, or an echo page with no address in it
 * (an error page, a blocked request) is not one.
 */
const echoed = (state: FlueConversationState, page: URL) =>
  toolParts(state).flatMap((part) => {
    if (part.toolName !== 'browse' || part.state !== 'output-available') return []
    return Option.match(decodeReceipt(part.output), {
      onNone: () => [],
      onSome: ({ result }) => {
        if (!URL.canParse(result.address)) return []
        if (new URL(result.address).href !== page.href) return []
        const found = ADDRESS.exec(result.outline)
        return found === null ? [] : [found[0]]
      },
    })
  })

/**
 * Asks Vivid to open the echo page on its Computer, and answers the address in the receipt the
 * browser left for this attempt’s unique URL. Both readings reuse one tab: Cua 0.23.2 proves
 * selection from a unique native title, so two identically titled echo tabs are ambiguous
 * (`cua-driver-core/src/browser/binding.rs`, `selected_tab_target_id`). A new query means only
 * a receipt from fresh navigation can match; reading the previous page fails the proof.
 */
const asked = Effect.fn('EgressProof.asked')(function* (fixture: ChainFixture) {
  const address = new URL(ECHO)
  // A public echo label must survive modelText, which hides UUID-shaped private references.
  address.searchParams.set('vivid-proof', NodeCrypto.randomBytes(6).toString('hex'))
  const runId = yield* fixture.send(
    `Navigate the current browser tab on Vivid’s Computer to ${address.href}. This is a new address and needs a fresh navigation. Reply with exactly the IP address the page shows, nothing else.`,
  )
  const seen = echoed(yield* completeRun(fixture, runId), address)
  const latest = Arr.last(seen)
  if (Option.isNone(latest))
    return yield* Effect.sync(() =>
      expect.fail('The Computer’s browser left no receipt for the echo page in this Run'),
    )
  return latest.value
})

/** Waits until the Person's live egress status is the one named. */
const egressIs = (fixture: ChainFixture, tag: EgressStatus['_tag']) =>
  fixture.rpc.WatchEgress().pipe(
    Stream.filter((status) => status._tag === tag),
    Stream.runHead,
  )

/** Waits until the Person's live Computer is in the state named. */
const computerIs = (fixture: ChainFixture, accepts: (state: ComputerState) => boolean) =>
  fixture.rpc.WatchComputer().pipe(
    Stream.filter((answer) => accepts(answer.computer.state)),
    Stream.runHead,
  )

describe.skipIf(process.env['VIVID_LIVE_EGRESS'] !== '1')('Egress, live', () => {
  layer(NodeHttpClient.layerUndici, { excludeTestServices: true, timeout: 900_000 })((it) => {
    it.effect(
      'a page on the Computer sees the desktop app’s address with egress on, and the Computer’s with it off',
      () =>
        Effect.gen(function* () {
          const fixture = yield* chainSession(
            yield* Config.Redacted('VIVID_LIVE_EGRESS_COOKIE'),
            'Egress proof',
          )
          const known = yield* Config.option(Config.NonEmptyString('VIVID_LIVE_EGRESS_ADDRESS'))
          yield* Effect.addFinalizer(() =>
            fixture.rpc
              .PatchSettings(new PatchSettingsRequest({ egress: false }))
              .pipe(Effect.ignore),
          )
          yield* fixture.rpc.PatchSettings(new PatchSettingsRequest({ egress: true }))
          // A browser that was started before egress was on goes out directly for as long as it
          // runs, so the Computer is started afresh with egress already chosen.
          yield* fixture.rpc.StopComputer()
          yield* computerIs(fixture, (state) => !ComputerState.guards.Running(state))
          yield* fixture.rpc.StartComputer()
          yield* computerIs(fixture, ComputerState.guards.Running)
          yield* egressIs(fixture, 'Routing')
          const through = yield* asked(fixture)

          yield* fixture.rpc.PatchSettings(new PatchSettingsRequest({ egress: false }))
          yield* egressIs(fixture, 'Off')
          const direct = yield* asked(fixture)

          expect(through, 'With egress on the page must not see the Computer’s address').not.toBe(
            direct,
          )
          // With the device's address known, the page must have seen exactly it, and the
          // Computer's own address must be another.
          if (Option.isSome(known)) {
            expect(through).toBe(known.value)
            expect(direct).not.toBe(known.value)
          }
        }).pipe(Effect.scoped),
      { timeout: 900_000 },
    )
  })
})

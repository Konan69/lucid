import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ComputerState, EgressStatus, PatchSettingsRequest } from '@vivid/contracts'
import { Config, Effect, Option, Stream } from 'effect'
import { type ChainFixture, chainSession, completeRun, replyText } from '../../runtime/chains.ts'

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
 *   The page's answer with egress on is then also compared with it.
 *
 * What it does to that Person's account: it turns egress on and, at the end, off again; it stops
 * and starts their Computer, so that the browser is started after egress was turned on (a
 * browser keeps the way out it started with); and it leaves one Thread, "Egress proof".
 *
 * The page is opened by Vivid, in a real Run, because that is the only thing that opens a page
 * in the Computer's browser. The same question is asked twice: with egress on, and with it off,
 * when the Computer's proxy goes out from the Computer itself. The two answers are the two
 * addresses. It is not run by the gate; run it with Vitest directly.
 */
const ECHO = 'https://api.ipify.org'

/** An IPv4 or IPv6 address somewhere in what Vivid said. */
const ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/iu

/** Asks Vivid to open the echo page on its Computer and answers the address it reported. */
const asked = Effect.fn('EgressProof.asked')(function* (fixture: ChainFixture) {
  const runId = yield* fixture.send(
    `Open ${ECHO} in a new tab of the browser on your computer and reply with exactly the address the page shows, nothing else.`,
  )
  const state = yield* completeRun(fixture, runId)
  const found = ADDRESS.exec(replyText(state))
  if (found === null) return yield* Effect.sync(() => expect.fail('Vivid reported no address'))
  return found[0]
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
          if (Option.isSome(known)) expect(through).toBe(known.value)
        }).pipe(Effect.scoped),
      { timeout: 900_000 },
    )
  })
})

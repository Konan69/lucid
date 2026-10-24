import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, DeviceAnswer } from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { chromium, type ChromiumPage } from './chromium.ts'
import { executor } from './control.ts'

/**
 * Opt-in, and never part of a gate: it starts a real Chromium.
 *
 *     VIVID_LIVE_BROWSER=1 VIVID_LIVE_BROWSER_PATH=<the Chromium or Chrome executable> \
 *       pnpm --filter @vivid/desktop exec vitest run src/main/control.live.test.ts
 *
 * It needs no display and no credentials, and the proof does not depend on a network: Chromium
 * runs headless and the only documents it is given are the two written below, which load nothing
 * else. Chromium's own background requests are not turned off; nothing here waits for them.
 * `VIVID_LIVE_BROWSER_PATH` has no default; without it the tests fail rather than look for a
 * browser.
 */
const live = process.env['VIVID_LIVE_BROWSER'] === '1'

/**
 * What Chromium itself says is on a page's window, and what the page keeps there.
 *
 * `DOMDebugger.getEventListeners` is Chromium's own list of the listeners on an object: every
 * one, whoever added it, with its event and whether it listens on the way down. It is asked
 * about the page's `window`, where all of the executor's page scripts listen. No script of the
 * executor is repeated here: a listener it forgot is counted without knowing what it looks like.
 */
const Listeners = Schema.Struct({
  listeners: Schema.Array(Schema.Struct({ type: Schema.String, useCapture: Schema.Boolean })),
})
const decodeWindow = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ objectId: Schema.String }) }),
)
const decodeListeners = Schema.decodeUnknownEffect(Listeners)
const decodeReady = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Literal('ready') }) }),
)
const decodeInput = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Literals(['keydown', 'mousedown']) }) }),
)
const decodeKept = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      value: Schema.Struct({ document: Schema.Finite, symbols: Schema.Int }),
    }),
  }),
)

/**
 * Everything a test can see that an action left in the page:
 * - `listeners`: how many listeners the window has of each event and direction.
 * - `symbols`: how many symbol-named values the window holds. The executor's scripts keep their
 *   notes under symbols, so one left behind raises this.
 * - `document`: when this document began, in the page's own clock. It only changes when the page
 *   has moved to another document, which would empty the window and prove nothing.
 */
const left = Effect.fn('ControlProof.left')(function* (page: ChromiumPage) {
  const window = yield* page
    .send('Runtime.evaluate', { expression: 'window', objectGroup: 'vivid-proof' })
    .pipe(Effect.flatMap(decodeWindow))
  const { listeners } = yield* page
    .send('DOMDebugger.getEventListeners', { objectId: window.result.objectId })
    .pipe(Effect.flatMap(decodeListeners))
  yield* page.send('Runtime.releaseObjectGroup', { objectGroup: 'vivid-proof' })
  const kept = yield* page
    .send('Runtime.evaluate', {
      expression:
        '({ document: performance.timeOrigin, symbols: Object.getOwnPropertySymbols(window).length })',
      returnByValue: true,
    })
    .pipe(Effect.flatMap(decodeKept))
  const counted = new Map<string, number>()
  for (const each of listeners) {
    const kind = `${each.type} ${each.useCapture ? 'down' : 'up'}`
    counted.set(kind, Option.getOrElse(Option.fromUndefinedOr(counted.get(kind)), () => 0) + 1)
  }
  return { listeners: Object.fromEntries(counted), ...kept.result.value }
})

/**
 * A page that takes what Vivid sends it and writes down what it saw. Its two listeners are its
 * own and are there before Vivid acts, so they are part of what the window starts with.
 */
const HEARING = `<!doctype html>
<title>Hearing</title>
<button>Send</button>
<p id="saw">nothing yet</p>
<script>
  const saw = document.getElementById("saw")
  window.addEventListener("keydown", (event) => { saw.textContent = "saw key " + event.key })
  window.addEventListener("mousedown", () => { saw.textContent = "saw the button" })
</script>`

/**
 * This page receives real input but stops it before the executor's receipt listener. Its own
 * EventTarget reports each stopped event through a Promise awaited over Runtime.evaluate.
 * The proof can then press Stop without guessing when dispatch happened or changing Chromium's
 * focus implementation. Cancellation must remove the executor's listeners on the same document.
 */
const DEAF = `<!doctype html>
<title>Deaf</title>
<button>Send</button>
<script>
  const input = new EventTarget()
  function nextInput(event) {
    globalThis.receipt = new Promise((resolve) => {
      input.addEventListener(event, () => resolve(event), { once: true })
    })
    return "ready"
  }
  for (const event of ["keydown", "mousedown"])
    window.addEventListener(event, (heard) => {
      heard.stopImmediatePropagation()
      input.dispatchEvent(new Event(heard.type))
    }, true)
</script>`

const enter = BrowserAction.cases.Press.make({ key: 'Enter' })
const send = BrowserAction.cases.Click.make({ target: 'Send' })

/** A real Chromium, one page on this document, and the production executor acting on it. */
const acting = Effect.fn('ControlProof.acting')(function* (html: string) {
  const browser = yield* chromium(yield* Config.NonEmptyString('VIVID_LIVE_BROWSER_PATH'))
  const page = yield* browser.open(html)
  const control = yield* executor({
    browser: page.browser,
    mac: false,
    using: () => {},
    mayOpen: () => Effect.succeed(false),
  })
  /** One action with a minute to finish, far more than any here takes. */
  const act = Effect.fn('ControlProof.act')(function* (action: BrowserAction) {
    const now = yield* Clock.currentTimeMillis
    return yield* control.execute({ action, expiresAt: now + 60_000 })
  })
  // The adapter owns one page. Stop uses that page's public tab identity.
  const stop = Effect.sync(() => {
    for (const tab of page.browser.state().tabs) control.stop(tab.tab)
  })
  return { page, act, stop }
})

/** The action was carried out, and the page it left says these words. */
const doneSaying = (words: string) => (answer: Option.Option<DeviceAnswer>) =>
  Option.exists(
    answer,
    (given) => DeviceAnswer.guards.Done(given) && given.result.outline.includes(words),
  )

describe.skipIf(!live)("what Vivid's actions leave in a real page", () => {
  it.live(
    'a key and a click the page takes leave its window as it was',
    () =>
      Effect.gen(function* () {
        const { page, act } = yield* acting(HEARING)
        const before = yield* left(page)
        // The measure sees listeners at all: the page's own two are in it.
        expect(before.listeners).toEqual({ 'keydown up': 1, 'mousedown up': 1 })

        const pressed = yield* act(enter)
        expect(pressed).toSatisfy(doneSaying('saw key Enter'))
        expect(yield* left(page)).toEqual(before)

        const clicked = yield* act(send)
        expect(clicked).toSatisfy(doneSaying('saw the button'))
        expect(yield* left(page)).toEqual(before)
      }),
    60_000,
  )

  it.live(
    'stopping keys and clicks with no input receipt leaves the same document clean',
    () =>
      Effect.gen(function* () {
        const { page, act, stop } = yield* acting(DEAF)
        const before = yield* left(page)
        expect(before.listeners).toEqual({
          'keydown down': 1,
          'mousedown down': 1,
        })

        for (const { action, event } of [
          { action: enter, event: 'keydown' },
          { action: send, event: 'mousedown' },
          { action: enter, event: 'keydown' },
          { action: send, event: 'mousedown' },
          { action: enter, event: 'keydown' },
          { action: send, event: 'mousedown' },
        ]) {
          yield* page
            .send('Runtime.evaluate', {
              expression: `nextInput(${JSON.stringify(event)})`,
              returnByValue: true,
            })
            .pipe(Effect.flatMap(decodeReady))
          const pending = yield* act(action).pipe(Effect.forkScoped)
          const received = yield* page
            .send('Runtime.evaluate', {
              expression: 'globalThis.receipt',
              awaitPromise: true,
              returnByValue: true,
            })
            .pipe(Effect.flatMap(decodeInput))
          expect(received.result.value).toBe(event)
          yield* stop
          expect(yield* Fiber.join(pending)).toEqual(
            Option.some(DeviceAnswer.cases.Refused.make({ reason: 'Stopped' })),
          )
          expect(yield* left(page)).toEqual(before)
        }
      }),
    60_000,
  )
})

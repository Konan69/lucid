import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, DeviceAnswer } from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
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
 * A page Vivid's scripts never hear from. It says it has no focus, and for each of the three
 * events the scripts wait for it has a listener of its own, added first and on the way down, that
 * stops the event there: the scripts' listeners are added and never called. That is the state a
 * dropped press leaves a page in, made on purpose: every wait runs out, which is when a listener
 * used to stay behind.
 */
const DEAF = `<!doctype html>
<title>Deaf</title>
<button>Send</button>
<script>
  document.hasFocus = () => false
  for (const event of ["focus", "keydown", "mousedown"])
    window.addEventListener(event, (heard) => heard.stopImmediatePropagation(), true)
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
  return { page, act }
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
    'keys and clicks a page never hears, again and again on one document, leave its window as it was',
    () =>
      Effect.gen(function* () {
        const { page, act } = yield* acting(DEAF)
        const before = yield* left(page)
        expect(before.listeners).toEqual({
          'focus down': 1,
          'keydown down': 1,
          'mousedown down': 1,
        })

        // Each action waits out the page's focus (two seconds) and then its press (half a
        // second): the two waits that used to leave a listener each, and `arm` a third.
        for (const action of [enter, send, enter, send, enter, send]) {
          expect(yield* act(action)).toEqual(Option.some(DeviceAnswer.cases.Failed.make({})))
          expect(yield* left(page)).toEqual(before)
        }
      }),
    120_000,
  )
})

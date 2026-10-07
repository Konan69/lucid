import { Effect, Schema } from 'effect'
import { BrowserStepFailed } from '../machine.ts'
import type { Driver } from './driver.ts'
import { ActionReceipt } from './receipt.ts'

// AT-SPI extents are screen pixels; Cua click expects pixels in its window screenshot.
const Extent = Schema.Int.check(Schema.isGreaterThan(0))
const Frame = Schema.Struct({ x: Schema.Int, y: Schema.Int, w: Extent, h: Extent })
const WindowPage = Schema.Struct({
  pid: Schema.Int,
  window_id: Schema.Int,
  screenshot_width: Schema.Int.check(Schema.isGreaterThan(0)),
  screenshot_height: Schema.Int.check(Schema.isGreaterThan(0)),
  screenshot_mime_type: Schema.Literal('image/png'),
  elements: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      depth: Schema.Int,
      label: Schema.optionalKey(Schema.String),
      enabled: Schema.optionalKey(Schema.Boolean),
      in_web_content: Schema.optionalKey(Schema.Boolean),
      frame: Schema.optionalKey(Frame),
    }),
  ),
})

/** A window query retains ancestors; its sole top-level frame supplies the screen origin. */
const originFrame = Effect.fn('Machine.boat.browser.origin')(function* (
  state: typeof WindowPage.Type,
) {
  const roots = state.elements.filter((item) => item.role === 'frame' && item.depth === 0)
  const root = roots[0]
  if (roots.length !== 1 || root === undefined || root.frame === undefined)
    return yield* new BrowserStepFailed()
  return root.frame
})

/** Only an enabled page control may supply coordinates; same-label browser chrome is excluded. */
const controlFrame = Effect.fn('Machine.boat.browser.control')(function* (
  state: typeof WindowPage.Type,
  target: string,
) {
  const matches = state.elements.filter(
    (item) =>
      item.in_web_content === true &&
      item.enabled === true &&
      item.label !== undefined &&
      item.label.toLocaleLowerCase() === target.toLocaleLowerCase(),
  )
  const element = matches[0]
  if (matches.length !== 1 || element === undefined || element.frame === undefined)
    return yield* new BrowserStepFailed()
  return element.frame
})

/** Linux 0.23.2 refuses background trusted CDP clicks unconditionally for standalone Chrome.
 * Use the public foreground desktop tool on the same Person-visible window. The semantic
 * caller has already proven a unique page control; this second snapshot joins its exact label
 * to web-content AT-SPI extents, never browser chrome or guessed CSS-to-screen offsets.
 * Missing, ambiguous, disabled or off-window bounds fail before input. Capture scaling is
 * inverted here because Cua applies its recorded resize ratio when delivering pixel input. */
export const click = Effect.fn('Machine.boat.browser.pointer')(function* (
  native: Driver,
  window: { readonly pid: number; readonly window_id: number },
  target: string,
) {
  const state = yield* native.window({ ...window, query: target }, WindowPage)
  if (state.pid !== window.pid || state.window_id !== window.window_id)
    return yield* new BrowserStepFailed()
  const origin = yield* originFrame(state)
  const frame = yield* controlFrame(state, target)
  const x = frame.x - origin.x + frame.w / 2
  const y = frame.y - origin.y + frame.h / 2
  if (x < 0 || y < 0 || x >= origin.w || y >= origin.h) return yield* new BrowserStepFailed()
  yield* native.call(
    'click',
    {
      ...window,
      x: (x * state.screenshot_width) / origin.w,
      y: (y * state.screenshot_height) / origin.h,
      delivery_mode: 'foreground',
    },
    ActionReceipt,
  )
  return undefined
})

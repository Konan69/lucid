import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { chrome } from '../boat/browser.ts'
import type { Driver } from '../boat/driver.ts'
import { EGRESS_PROXY_ADDRESS, browserProxy } from './guest.ts'

/**
 * Whether the Computer's browser is started with the egress proxy: from the Person's choice to
 * the arguments the browser is launched with. The two halves are the product's own
 * (`browserProxy`, and `chrome`, the step that launches); between them is one call
 * (`boat.ts`, `browse`). The desktop is the smallest thing with the driver's shape: it lists a
 * browser window once a browser has been launched, and keeps what each launch was given.
 */
const desktop = (running: boolean) => {
  const launched: Array<unknown> = []
  const state = { running, launched }
  const window = {
    pid: 7,
    window_id: 9,
    app_name: 'Google Chrome',
    title: 'New Tab',
    bounds: { x: 0, y: 0, width: 945, height: 920 },
    height: 920,
    width: 945,
    x: 0,
    y: 0,
    is_on_screen: true,
    z_index: 0,
  }
  const call: Driver['call'] = (tool, args, schema) =>
    Effect.suspend(() => {
      if (tool === 'launch_app') {
        state.launched.push(args['additional_arguments'])
        state.running = true
      }
      return Schema.decodeEffect(schema)(
        tool === 'launch_app'
          ? { running: true, pid: 7, windows: [] }
          : { windows: state.running ? [window] : [] },
      ).pipe(Effect.orDie)
    })
  return { state, native: { call } }
}

describe('the browser’s way out when it is started', () => {
  it.effect('with egress on and the proxy listening, the browser is launched through it', () =>
    Effect.gen(function* () {
      const { state, native } = desktop(false)
      yield* chrome(native, true, browserProxy(true, Effect.succeed(true)))
      expect(state.launched).toEqual([
        ['--force-renderer-accessibility', `--proxy-server=${EGRESS_PROXY_ADDRESS}`],
      ])
      expect(EGRESS_PROXY_ADDRESS).toBe('http://127.0.0.1:8791')
    }),
  )

  it.effect('with egress off the browser is launched without a proxy, and none is started', () =>
    Effect.gen(function* () {
      const { state, native } = desktop(false)
      const started = { times: 0 }
      const listening = Effect.sync(() => {
        started.times += 1
        return true
      })
      yield* chrome(native, true, browserProxy(false, listening))
      expect(state.launched).toEqual([['--force-renderer-accessibility']])
      expect(started.times).toBe(0)
    }),
  )

  it.effect('with egress on and no proxy to be had, the browser still starts, directly', () =>
    Effect.gen(function* () {
      const { state, native } = desktop(false)
      yield* chrome(native, true, browserProxy(true, Effect.succeed(false)))
      expect(state.launched).toEqual([['--force-renderer-accessibility']])
    }),
  )

  it.effect('a browser that is already running is left as it started, and nothing is asked', () =>
    Effect.gen(function* () {
      const { state, native } = desktop(true)
      const asked = { times: 0 }
      const proxy = Effect.sync(() => {
        asked.times += 1
        return Option.some(EGRESS_PROXY_ADDRESS)
      })
      expect(yield* chrome(native, true, proxy)).toEqual({ pid: 7, window_id: 9 })
      expect(state.launched).toEqual([])
      expect(asked.times).toBe(0)
    }),
  )
})

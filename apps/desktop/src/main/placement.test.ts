import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { DisplayWorkArea, WindowPlacement, clampWindowPlacement } from './placement.ts'

const primary = DisplayWorkArea.make({ x: 0, y: 0, width: 1440, height: 900 })
const secondary = DisplayWorkArea.make({ x: 1440, y: 0, width: 1920, height: 1080 })

/** Fail clearly when a display-backed test unexpectedly produces no placement. */
const requirePlacement = (placement: Option.Option<WindowPlacement>): WindowPlacement =>
  Option.getOrThrowWith(placement, () => new Error('expected a visible placement'))

describe('window placement', () => {
  it.effect('clamps an oversized off-screen window wholly into the nearest display', () =>
    Effect.sync(() => {
      const placement = WindowPlacement.cases.Positioned.make({
        width: 2400,
        height: 1400,
        x: 5000,
        y: 1200,
        maximized: false,
      })
      const clamped = requirePlacement(clampWindowPlacement(placement, [primary, secondary]))

      expect(WindowPlacement.guards.Positioned(clamped)).toBe(true)
      if (!WindowPlacement.guards.Positioned(clamped)) return
      expect(clamped).toEqual(
        WindowPlacement.cases.Positioned.make({
          width: 1920,
          height: 1080,
          x: 1440,
          y: 0,
          maximized: false,
        }),
      )
    }),
  )

  it.effect('raises undersized geometry to the usable minimum', () =>
    Effect.sync(() => {
      const placement = WindowPlacement.cases.Positioned.make({
        width: 300,
        height: 200,
        x: 100,
        y: 100,
        maximized: true,
      })
      const clamped = requirePlacement(clampWindowPlacement(placement, [primary]))

      expect(WindowPlacement.guards.Positioned(clamped)).toBe(true)
      if (!WindowPlacement.guards.Positioned(clamped)) return
      expect(clamped.width).toBe(720)
      expect(clamped.height).toBe(480)
      expect(clamped.x).toBe(100)
      expect(clamped.y).toBe(100)
      expect(clamped.maximized).toBe(true)
    }),
  )

  it.effect('represents the absence of connected displays explicitly', () =>
    Effect.sync(() => {
      const placement = WindowPlacement.cases.Centered.make({
        width: 1280,
        height: 800,
        maximized: false,
      })
      expect(Option.isNone(clampWindowPlacement(placement, []))).toBe(true)
    }),
  )
})

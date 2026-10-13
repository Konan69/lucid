import { describe, expect, it } from 'vitest'
import { paced, REVEAL, revealed, revealer, type Frames } from './reveal'

/** Frames a test turns by hand: a clock it sets and the one step that is waiting. */
const hand = () => {
  const at = { now: 0, instant: false }
  const waiting: Array<() => void> = []
  const frames: Frames = {
    now: () => at.now,
    next: (step) => {
      waiting.push(step)
      return () => {
        const index = waiting.indexOf(step)
        if (index >= 0) waiting.splice(index, 1)
      }
    },
    instant: () => at.instant,
  }
  /** Lets `ms` pass and runs whatever step was waiting. */
  const turn = (ms: number) => {
    at.now += ms
    for (const step of waiting.splice(0)) step()
  }
  return { at, frames, turn, pending: () => waiting.length }
}

describe('pacing a reply', () => {
  it('drains a backlog in about the settle time, in many small steps', () => {
    let shown = 0
    let steps = 0
    while (shown < 30 && steps < 100) {
      shown = paced({ shown, total: 30, elapsedMs: REVEAL.frameMs })
      steps += 1
    }
    expect(steps).toBeGreaterThan(4)
    expect(steps * REVEAL.frameMs).toBeLessThanOrEqual(REVEAL.settleMs * 3)
  })

  it('moves faster the more is waiting, so it never falls further behind', () => {
    const little = paced({ shown: 0, total: 10, elapsedMs: REVEAL.frameMs })
    const much = paced({ shown: 0, total: 1000, elapsedMs: REVEAL.frameMs })
    expect(much).toBeGreaterThan(little * 10)
  })

  it('never shows half of a two-unit character', () => {
    expect(revealed('ok 😀 done', 4)).toBe('ok 😀')
    expect(revealed('ok 😀 done', 5)).toBe('ok 😀')
  })
})

describe('one reply being revealed', () => {
  it('does not type out what was already there when it was first drawn', () => {
    const { frames, pending } = hand()
    const reveal = revealer(frames, 12)
    reveal.toward(12)(() => undefined)
    expect(reveal.read()).toBe(12)
    expect(pending()).toBe(0)
  })

  it('paces what arrives afterwards, tells the screen at each step, then stops', () => {
    const { frames, turn, pending } = hand()
    const reveal = revealer(frames, 5)
    let heard = 0
    reveal.toward(35)(() => {
      heard += 1
    })
    turn(REVEAL.frameMs)
    expect(reveal.read()).toBeGreaterThan(5)
    expect(reveal.read()).toBeLessThan(35)
    for (let index = 0; index < 60; index += 1) turn(REVEAL.frameMs)
    expect(reveal.read()).toBe(35)
    expect(heard).toBeGreaterThan(3)
    expect(pending()).toBe(0)
  })

  it('keeps its place when more text arrives and the screen follows the longer text', () => {
    const { frames, turn } = hand()
    const reveal = revealer(frames, 0)
    const stop = reveal.toward(20)(() => undefined)
    turn(REVEAL.frameMs)
    const first = reveal.read()
    stop()
    reveal.toward(60)(() => undefined)
    turn(REVEAL.frameMs)
    expect(reveal.read()).toBeGreaterThan(first)
  })

  it('keeps moving when more text arrives faster than a step, each arrival a new subscription', () => {
    const { frames, turn } = hand()
    const reveal = revealer(frames, 0)
    let stop = reveal.toward(10)(() => undefined)
    for (let lump = 1; lump <= 50; lump += 1) {
      turn(REVEAL.frameMs / 2)
      stop()
      stop = reveal.toward(10 + lump * 5)(() => undefined)
    }
    expect(reveal.read()).toBeGreaterThan(50)
  })

  it('shows everything at once when nobody can see pacing, and steps nothing once let go', () => {
    const hidden = hand()
    hidden.at.instant = true
    const shownAtOnce = revealer(hidden.frames, 0)
    shownAtOnce.toward(500)(() => undefined)
    hidden.turn(1)
    expect(shownAtOnce.read()).toBe(500)

    const left = hand()
    const letGo = revealer(left.frames, 0)
    letGo.toward(500)(() => undefined)()
    left.turn(REVEAL.frameMs)
    expect(letGo.read()).toBe(0)
  })
})

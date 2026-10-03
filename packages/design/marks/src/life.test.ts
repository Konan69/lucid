import { describe, expect, it } from 'vitest'
import {
  FACE_BLINK_MS,
  FACE_MIN_HOLD_MS,
  FACE_STATES,
  faceBeat,
  faceState,
  faceStill,
  type FaceSignals,
} from './life.js'

const quiet: FaceSignals = {
  answering: false,
  usingTool: false,
  personWriting: false,
  failed: false,
  needsPerson: false,
  finished: false,
}

/** The looks of a state's first beats, with every hold drawn at its minimum. */
const looks = (state: (typeof FACE_STATES)[number], beats: number) =>
  Array.from({ length: beats }, (_, position) => faceBeat(state, position, () => 0).mood)

describe('faceState', () => {
  it('rests when nothing is true', () => {
    expect(faceState(quiet)).toBe('idle')
  })

  it('tells a running tool from thinking between steps', () => {
    expect(faceState({ ...quiet, answering: true })).toBe('thinking')
    expect(faceState({ ...quiet, answering: true, usingTool: true })).toBe('working')
  })

  it('gives Vivid the floor while it answers, whatever else is true', () => {
    expect(
      faceState({
        ...quiet,
        answering: true,
        personWriting: true,
        failed: true,
        needsPerson: true,
      }),
    ).toBe('thinking')
  })

  it('listens to a Person who writes after a failure or an open question', () => {
    expect(faceState({ ...quiet, personWriting: true, failed: true, needsPerson: true })).toBe(
      'listening',
    )
  })

  it('shows a failure before an open question, and either before a finished answer', () => {
    expect(faceState({ ...quiet, failed: true, needsPerson: true, finished: true })).toBe('failed')
    expect(faceState({ ...quiet, needsPerson: true, finished: true })).toBe('waiting')
    expect(faceState({ ...quiet, finished: true })).toBe('done')
  })
})

describe('faceBeat', () => {
  it('plays the opening pose once, then settles into the loop', () => {
    // Pleased once, then level with a blink, and never pleased again.
    expect(looks('done', 5)).toEqual(['happy', 'neutral', 'asleep', 'neutral', 'asleep'])
    expect(looks('failed', 4)).toEqual(['asleep', 'neutral', 'asleep', 'neutral'])
  })

  it('opens thinking and working on the same look, so moving between them does not twitch', () => {
    expect(faceStill('thinking')).toBe(faceStill('working'))
  })

  it('draws a hold between the bounds of the pose', () => {
    expect(faceBeat('idle', 0, () => 0).holdMs).toBe(9000)
    expect(faceBeat('idle', 0, () => 0.5).holdMs).toBe(12_500)
    expect(faceBeat('thinking', 0, () => 0.999).holdMs).toBeLessThanOrEqual(3600)
  })

  it('lifts a hold shorter than the floor up to it', () => {
    // The wince is drawn from 900 to 1800 ms; at its minimum it would be shorter than any pose may be.
    expect(faceBeat('failed', 0, () => 0).holdMs).toBe(FACE_MIN_HOLD_MS)
    expect(faceBeat('failed', 0, () => 0.999).holdMs).toBeGreaterThan(FACE_MIN_HOLD_MS)
  })

  it('keeps a blink short: the floor does not apply to it', () => {
    expect(faceBeat('idle', 1, () => 0.7)).toEqual({ mood: 'asleep', holdMs: FACE_BLINK_MS })
  })

  it('only blinks out of a level pose, in every state', () => {
    for (const state of FACE_STATES) {
      const seen = looks(state, 12)
      seen.forEach((mood, position) => {
        // A blink is the closed-eye look held for the blink's time; a wince is held far longer.
        const isBlink = faceBeat(state, position, () => 0).holdMs === FACE_BLINK_MS
        if (mood === 'asleep' && isBlink) expect(seen[position - 1]).toBe('neutral')
      })
    }
  })
})

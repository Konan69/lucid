import type { FaceMood } from './face.js'

/**
 * What makes Vivid's face look alive: a small state machine that says which look the face holds,
 * and for how long, in each thing Vivid can be doing.
 *
 * The design is Grok Bot's avatar machine (`refs/grok-bot-0.30/avatar/states.ts`, recovered from
 * its 0.30.0 renderer): a state names a short sequence of poses, the face holds each pose for a
 * time drawn at random between two bounds, then moves to the next with one cross-fade. Nothing
 * runs between poses, so a face at rest costs nothing; it only ever changes once and holds.
 *
 * Kept from the reference, unchanged: the pose-sequence-per-state model (`STATE_POSES`), the
 * random hold between a minimum and a maximum (`HOLD_MS`, and `HOLD_MS_VARIANT` where named),
 * the 300 ms cross-fade (`CROSSFADE_MS`) and the 1500 ms floor (`MIN_HOLD_MS`).
 *
 * Changed, and why:
 * - Seven states, not thirty-nine. Vivid shows what it is really doing, so a state exists only
 *   where the product has a signal for it. The reference's reactions (excited, shy, angry…) have
 *   no such signal here and are not ported.
 * - Four drawings, not twenty-five. Vivid's face has the moods of `face.ts`, so a pose is a
 *   `FaceMood`. Where the reference steps through several sprites, Vivid alternates the leans it
 *   has, and adds a blink: the `asleep` drawing (eyes closed to a slit) held for a moment.
 * - A sequence may open with poses shown once (`once`) before it settles into its loop. The
 *   reference does this with separate short states (`surprised`, then back to `idle`); a face
 *   driven by derived state has no "then", so the settling is part of the state.
 *
 * Not proved from the reference: whether its 1500 ms floor (`N3t`) clamps one pose or a whole
 * state. Here it is the least time any pose is held, a blink excepted.
 */

const FACE_STATES = [
  'idle',
  'listening',
  'thinking',
  'working',
  'waiting',
  'done',
  'failed',
] as const

/**
 * What Vivid is doing, as its face shows it.
 * - `idle`       nothing is asked of it.
 * - `listening`  the Person is writing to it.
 * - `thinking`   it is answering, between steps.
 * - `working`    it is answering, and a tool is running.
 * - `waiting`    it cannot go on without the Person: a question or an Approval is open.
 * - `done`       it has just finished.
 * - `failed`     something did not work.
 */
export type FaceState = (typeof FACE_STATES)[number]

/** One pose of a sequence: the look, and the bounds its hold is drawn from, in milliseconds. */
interface FacePose {
  readonly mood: FaceMood
  readonly hold: readonly [min: number, max: number]
}

/** A state's poses: those shown once as it begins, then those it repeats for as long as it lasts. */
interface FaceSequence {
  readonly once: ReadonlyArray<FacePose>
  readonly loop: readonly [FacePose, ...Array<FacePose>]
}

/** The reference's cross-fade between poses (`CROSSFADE_MS`, `GXe=300`). */
const FACE_CROSSFADE_MS = 300

/** The reference's floor (`MIN_HOLD_MS`, `N3t=1500`): no pose but a blink is held for less. */
const FACE_MIN_HOLD_MS = 1500

/**
 * How long the eyes stay shut in a blink. A person's blink is 100 to 150 ms; the reference has
 * no blink of its own (its idle alternates two sprites), so this value is Vivid's.
 */
const FACE_BLINK_MS = 140

const blink: FacePose = { mood: 'asleep', hold: [FACE_BLINK_MS, FACE_BLINK_MS] }

/** The reference's hold bounds (`HOLD_MS`, table `Ine`) for the states Vivid borrows from. */
const HOLD = {
  idle: [9000, 16_000],
  /** `HOLD_MS_VARIANT.idle` (table `I3t`): a calmer idle, for a state that can last hours. */
  idleCalm: [6000, 14_000],
  listening: [2800, 5000],
  thinking: [2000, 3600],
  working: [1800, 3200],
  /** The reference's `notifying`: a short turn toward the Person. */
  notifying: [1500, 2600],
  /** The reference's `proud`: how long a finished job is enjoyed. */
  proud: [3500, 6000],
  /** The reference's `scared`: a spike. The floor lifts its 900 ms minimum to 1500. */
  scared: [900, 1800],
  /** The reference's `sad`. */
  sad: [4000, 7000],
} as const satisfies Record<string, FacePose['hold']>

const rest: FaceSequence['loop'] = [{ mood: 'neutral', hold: HOLD.idle }, blink]

/**
 * Each state's poses. The leans are `face.ts`'s: `thinking` leans back, `happy` leans in,
 * `neutral` sits level. A blink only follows a level pose: `asleep` is drawn level, so a blink
 * out of a lean would also nod the head.
 *
 * `thinking` and `working` open on the same pose on purpose. Vivid moves between them many times
 * in one answer (a tool starts, a tool ends), and a face that changed on each would twitch.
 */
const FACE_SEQUENCES = {
  // Reference `idle`: poses [0, 8], held 9 to 16 s. Here: level, and a blink.
  idle: { once: [], loop: rest },
  // Reference `listening`: three poses, 2.8 to 5 s. Here: leaning in to the Person, then level.
  listening: {
    once: [],
    loop: [
      { mood: 'happy', hold: HOLD.listening },
      { mood: 'neutral', hold: HOLD.listening },
    ],
  },
  // Reference `thinking`: five poses, 2 to 3.6 s. Here: leaning back, then level.
  thinking: {
    once: [],
    loop: [
      { mood: 'thinking', hold: HOLD.thinking },
      { mood: 'neutral', hold: HOLD.thinking },
    ],
  },
  // Reference `working`: four poses, 1.8 to 3.2 s, its busiest lifecycle state. Here: back, level,
  // back, in: the head goes between the work and the Person, faster than when it thinks.
  working: {
    once: [],
    loop: [
      { mood: 'thinking', hold: HOLD.working },
      { mood: 'neutral', hold: HOLD.working },
      { mood: 'thinking', hold: HOLD.working },
      { mood: 'happy', hold: HOLD.working },
    ],
  },
  // Reference `notifying` then a calm idle: it turns to the Person once, then every so often.
  waiting: {
    once: [{ mood: 'happy', hold: HOLD.notifying }],
    loop: [
      { mood: 'neutral', hold: HOLD.idleCalm },
      blink,
      { mood: 'happy', hold: HOLD.notifying },
    ],
  },
  // Reference `proud`, then `idle`: pleased for a few seconds, then at rest.
  done: { once: [{ mood: 'happy', hold: HOLD.proud }], loop: rest },
  // Reference `scared` (a wince: eyes shut), then `sad`: level, with slower blinks than at rest.
  failed: {
    once: [{ mood: 'asleep', hold: HOLD.scared }],
    loop: [{ mood: 'neutral', hold: HOLD.sad }, blink],
  },
} as const satisfies Record<FaceState, FaceSequence>

/** The look a state is known by: its first pose. What a face shows when it may not move. */
export const faceStill = (state: FaceState): FaceMood => faceBeat(state, 0, () => 0).mood

/** One beat of a state's timeline: the look, and how long it is held before the next. */
export interface FaceBeat {
  readonly mood: FaceMood
  readonly holdMs: number
}

/**
 * The beat at a position in a state's timeline: the opening poses first, then the loop, for ever.
 *
 * `random` is a number in [0, 1) that places the hold between the pose's bounds, as the reference
 * does; passing it in keeps this a pure function a test can pin. The floor applies to every pose
 * that is not a blink.
 */
export function faceBeat(state: FaceState, position: number, random: () => number): FaceBeat {
  const sequence: FaceSequence = FACE_SEQUENCES[state]
  const looped = position - sequence.once.length
  const pose = looped < 0 ? sequence.once[position] : sequence.loop[looped % sequence.loop.length]
  // Unreachable: `once` is indexed below its length and `loop` is never empty. It is here so the
  // type stays honest without an assertion.
  if (pose === undefined) return { mood: sequence.loop[0].mood, holdMs: FACE_MIN_HOLD_MS }
  const [min, max] = pose.hold
  const drawn = Math.round(min + (max - min) * random())
  return { mood: pose.mood, holdMs: pose === blink ? drawn : Math.max(FACE_MIN_HOLD_MS, drawn) }
}

/**
 * What is true of Vivid and the Person right now, as the screen knows it. Each is an independent
 * fact with its own source; `faceState` is the one place that ranks them.
 */
export interface FaceSignals {
  /** Vivid is answering: a Run is going. */
  readonly answering: boolean
  /** A tool is running inside that answer. */
  readonly usingTool: boolean
  /** The Person is writing to Vivid. */
  readonly personWriting: boolean
  /** The last attempt did not work, or Vivid cannot be reached. */
  readonly failed: boolean
  /** A question or an Approval is open and only the Person can close it. */
  readonly needsPerson: boolean
  /** Vivid finished an answer while the Person was here. */
  readonly finished: boolean
}

/**
 * The one state a face shows for what is true. The order is who has the floor: Vivid while it
 * answers; then the Person while they write (whatever went before, they are acting on it now);
 * then what Vivid has to say to them, the most pressing first.
 */
export function faceState(signals: FaceSignals): FaceState {
  if (signals.answering) return signals.usingTool ? 'working' : 'thinking'
  if (signals.personWriting) return 'listening'
  if (signals.failed) return 'failed'
  if (signals.needsPerson) return 'waiting'
  return signals.finished ? 'done' : 'idle'
}

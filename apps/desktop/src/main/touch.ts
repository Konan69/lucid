import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Tab } from '../shared/pages.ts'

/**
 * One press reaching a page: a pointer button going down at a point, or a key going down. Only
 * presses are signals, as in the reference, whose guest reports `pointerdown` and `keydown` and
 * nothing else (reference desktop `preview/PickPreload.ts`, `reportHumanPointerInput` and
 * `reportHumanKeyInput`). Moves, releases and wheel turns never decide who holds the page.
 */
export const InputSignal = Schema.TaggedUnion({
  Pointer: {
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.Literals(['left', 'middle', 'right'] as const),
  },
  Key: { key: Schema.String, code: Schema.String },
})
export type InputSignal = typeof InputSignal.Type

/** A press Vivid is about to make, and the moment after which it no longer excuses anything. */
export interface ExpectedInput {
  readonly signal: InputSignal
  readonly expiresAt: number
}

/**
 * How long an announced press may take to arrive, in milliseconds. The reference's value
 * (`preview/Manager.ts`, `expectAgentInput`: `expiresAt: now + 1_000`).
 */
export const EXPECTED_INPUT_MILLIS = 1_000

/**
 * Whether a press that arrived is the one that was announced. A pointer may land a pixel off after
 * Chromium rounds it; a key must be the same key on the same physical key. Ported from the
 * reference's `inputSignalsMatch` (`preview/Manager.ts`), with its tolerance of one pixel.
 */
export function signalsMatch(expected: InputSignal, arrived: InputSignal): boolean {
  return InputSignal.match(expected, {
    Pointer: (left) =>
      InputSignal.guards.Pointer(arrived) &&
      Math.abs(left.x - arrived.x) <= 1 &&
      Math.abs(left.y - arrived.y) <= 1 &&
      left.button === arrived.button,
    Key: (left) =>
      InputSignal.guards.Key(arrived) && left.key === arrived.key && left.code === arrived.code,
  })
}

/**
 * Takes one announced press off the list if the arrived press matches it. Expired announcements
 * are dropped first, and only the first match is spent, so two announced clicks at one point excuse
 * exactly two presses. Ported from the reference's `consumeExpectedAgentInput`.
 */
export function consumeExpected(
  pending: ReadonlyArray<ExpectedInput>,
  arrived: InputSignal,
  now: number,
) {
  const live = pending.filter((expected) => expected.expiresAt > now)
  const index = live.findIndex((expected) => signalsMatch(expected.signal, arrived))
  if (index < 0) return { matched: false, pending: live }
  return { matched: true, pending: live.filter((_, position) => position !== index) }
}

/** Who a press belongs to, for the page it reached. */
export type InputOwner =
  /** Vivid announced it; it goes through even to a page that is not in front. */
  | 'Vivid'
  /** Nobody announced it while Vivid was acting on that page: the Person has taken over. */
  | 'Person'
  /** Vivid is not acting on that page; the Browser's ordinary rules apply. */
  | 'Nobody'

/** The page Vivid is acting on, what it has announced, and how to end the action. */
interface Acting {
  readonly tab: Tab
  readonly expected: ReadonlyArray<ExpectedInput>
  readonly taken: () => void
}

/**
 * Tells Vivid's own presses from the Person's while Vivid acts on a page.
 *
 * Chromium delivers input sent through the debugger the same way it delivers a real key or click,
 * so the page and the app cannot tell them apart by looking at the event. The reference solves it
 * by announcing each press just before sending it and treating any press that was not announced
 * as the person taking the page back (`preview/Manager.ts`: `expectAgentInput`,
 * `consumeExpectedAgentInput`, `handleHumanInput`). This is that mechanism.
 *
 * What Vivid changes, and why:
 * - The reference hears presses from a preload inside the guest page. Vivid's pages have no
 *   preload at all, on purpose, so presses are heard in the main process from Electron's
 *   `before-input-event` and `before-mouse-event`, which see every key and pointer event on their
 *   way into the page. That call is synchronous, because it also decides whether the event may
 *   proceed, so this holds plain state and takes the time as an argument.
 * - The reference bumps a per-tab counter and each command compares it before and after. Vivid
 *   acts on one page at a time, so there is one slot, and taking over calls `taken` at once, which
 *   ends the action wherever it is, including in the middle of a wait.
 */
export class Touch {
  private acting = Option.none<Acting>()

  /** Vivid starts acting on a page. `taken` is called, once, if the Person presses anything. */
  begin(tab: Tab, taken: () => void): void {
    this.acting = Option.some({ tab, expected: [], taken })
  }

  /** The action is over, however it ended. Nothing announced survives it. */
  end(): void {
    this.acting = Option.none()
  }

  /** Whether Vivid is acting on this page right now. */
  drives(tab: Tab): boolean {
    return Option.exists(this.acting, (acting) => acting.tab === tab)
  }

  /** Announces a press Vivid is about to send to the page it is acting on. */
  expect(signal: InputSignal, now: number): void {
    this.acting = Option.map(this.acting, (acting) => ({
      ...acting,
      expected: [
        ...acting.expected.filter((expected) => expected.expiresAt > now),
        { signal, expiresAt: now + EXPECTED_INPUT_MILLIS },
      ],
    }))
  }

  /**
   * Decides whose press this is. A press nobody announced, on the page Vivid is acting on, ends
   * the action: the slot is cleared before `taken` runs so a second press cannot end it twice.
   */
  judge(tab: Tab, signal: InputSignal, now: number): InputOwner {
    if (Option.isNone(this.acting) || this.acting.value.tab !== tab) return 'Nobody'
    const acting = this.acting.value
    const { matched, pending } = consumeExpected(acting.expected, signal, now)
    if (matched) {
      this.acting = Option.some({ ...acting, expected: pending })
      return 'Vivid'
    }
    this.acting = Option.none()
    acting.taken()
    return 'Person'
  }
}

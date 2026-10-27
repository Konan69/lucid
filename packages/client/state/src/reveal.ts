/** Pace incoming reply chunks in the client so durable writes never wait for animation.
 * The backlog sets the character rate, bounded below by `floor`, and drains within `settleMs`.
 * Hidden pages skip pacing because nobody can see it and their timers are throttled. */
export const REVEAL = {
  /** The slowest the words come out, in characters a second, when little is waiting. */
  floor: 40,
  /** How long a backlog takes to drain, in milliseconds: a little over the gap between lumps. */
  settleMs: 250,
  /** The shortest time between two steps, in milliseconds: no more than 25 redraws a second. */
  frameMs: 40,
} as const

/**
 * How many characters are shown after `elapsedMs` more, given how many were shown and how many
 * there are. Always at least one more while any are waiting, and never more than there are.
 */
export const paced = (at: {
  readonly shown: number
  readonly total: number
  readonly elapsedMs: number
}): number => {
  const waiting = at.total - at.shown
  if (waiting <= 0) return at.total
  const rate = Math.max(REVEAL.floor, waiting / (REVEAL.settleMs / 1000))
  const step = Math.max(1, Math.round((rate * at.elapsedMs) / 1000))
  return Math.min(at.total, at.shown + step)
}

/**
 * The first `shown` characters of `text`, never ending between the two halves of one character
 * (an emoji is two UTF-16 units; half of one draws as a broken glyph for a frame).
 */
export const revealed = (text: string, shown: number): string => {
  if (shown >= text.length) return text
  const last = text.charCodeAt(shown - 1)
  const cutsPair = last >= 0xd800 && last <= 0xdbff
  return text.slice(0, cutsPair ? shown + 1 : shown)
}

/** What a surface supplies: its clock, its next frame, and when pacing has nobody to see it. */
export interface Frames {
  readonly now: () => number
  /** Runs `step` once, before the next paint. */
  readonly next: (step: () => void) => void
  /** The page is hidden, or the Person asked for less motion: words are shown at once. */
  readonly instant: () => boolean
}

/**
 * One reply's reveal, as an external store a screen reads with `useSyncExternalStore`. It is
 * made when the reply is first drawn, with everything it has then already shown: a reply opened
 * from history, or joined half way, is not typed out again. Only what arrives afterwards is
 * paced.
 *
 * `toward` is the store's subscription for a text of a given length; a screen makes it anew
 * when the length changes, which is at every lump. The steps are the reveal's own and outlive
 * any one subscription: a subscription only says how far there is to go and who to tell. Twice
 * a step that belonged to the subscription was lost (13 October 2026): first its clock started
 * over at every lump, then, on a device that draws slower than lumps arrive, the frame it was
 * waiting for was called off by the next lump before it ran. Both showed a reply frozen at its
 * first words until it had finished arriving. Steps run only while someone is listening and
 * words are waiting, so a finished reply schedules nothing, and nothing changes during a render.
 */
export const revealer = (frames: Frames, start: number) => {
  let shown = start
  let total = start
  let last = frames.now()
  let waiting = false
  const listening = new Set<() => void>()

  const step = () => {
    waiting = false
    if (listening.size === 0 || shown >= total) return
    const now = frames.now()
    if (frames.instant() || now - last >= REVEAL.frameMs) {
      shown = frames.instant() ? total : paced({ shown, total, elapsedMs: now - last })
      last = now
      for (const heard of listening) heard()
    }
    follow()
  }

  /** Asks for the next step when words are waiting and none is already asked for. */
  const follow = () => {
    if (waiting || shown >= total) return
    waiting = true
    frames.next(step)
  }

  return {
    read: () => shown,
    toward: (length: number) => (heard: () => void) => {
      // After a pause with nothing waiting, time starts from now: the pause is not owed as words.
      if (shown >= total && frames.now() - last > REVEAL.settleMs) last = frames.now()
      total = length
      listening.add(heard)
      follow()
      return () => {
        listening.delete(heard)
      }
    },
  }
}

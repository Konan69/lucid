/**
 * Pacing a reply's words onto the screen.
 *
 * A reply does not arrive a letter at a time. Flue writes what the model said to its durable
 * stream in batches, and production on 13 October 2026 delivered a 1,550-character reply as 48
 * to 104 lumps of twenty to thirty characters, 130 to 210 ms apart. Drawn as they land, the text
 * jumps five to eight times a second, which reads as stutter on every surface.
 *
 * The design is the AI SDK's `smoothStream` (`refs/ai-sdk/packages/ai/src/generate-text/
 * smooth-stream.ts`): hold what arrived in a buffer and let it out in small steps with a short
 * wait between them, and skip the wait when the page is hidden, where timers are throttled and
 * pacing has nobody to see it. Two things differ, because of where Vivid's text comes from:
 *
 * - It runs in the client, not in the stream. The AI SDK smooths on the server, between the
 *   model and the wire. Vivid's wire is Flue's durable stream, whose batches are also its
 *   stored record; pacing there would delay the record, and a reconnect replays whole batches
 *   whatever the server did.
 * - It steps by characters at a rate that follows the backlog, not by words at a fixed 10 ms.
 *   The lumps arrive at the model's speed, which varies between replies (40 to 150 characters a
 *   second were measured), so a fixed rate either falls behind or runs dry between lumps. The
 *   rate here empties what is waiting in `settleMs`, and never drops below `floor`.
 */
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
  /** Runs `step` before the next paint and answers how to call that off. */
  readonly next: (step: () => void) => () => void
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
 * when the length changes. Steps run only while the screen is subscribed and words are waiting,
 * so a finished reply schedules nothing, and nothing is changed during a render.
 */
export const revealer = (frames: Frames, start: number) => {
  let shown = start
  // When the last step ran. It is the reveal's own, not a subscription's: a screen subscribes
  // anew at every lump, and a clock that started over each time never reached the frame gate
  // when lumps came faster than it (found in review, 13 October 2026: nothing was shown for as
  // long as words arrived 20 ms apart).
  let last = frames.now()
  return {
    read: () => shown,
    toward: (total: number) => (heard: () => void) => {
      if (shown >= total) return () => undefined
      // After a pause with nothing waiting, time starts from now: the pause is not owed as words.
      if (frames.now() - last > REVEAL.settleMs) last = frames.now()
      let cancel: () => void = () => undefined
      const step = () => {
        const now = frames.now()
        if (!frames.instant() && now - last < REVEAL.frameMs) {
          cancel = frames.next(step)
          return
        }
        shown = frames.instant() ? total : paced({ shown, total, elapsedMs: now - last })
        last = now
        heard()
        if (shown < total) cancel = frames.next(step)
      }
      cancel = frames.next(step)
      return () => cancel()
    },
  }
}

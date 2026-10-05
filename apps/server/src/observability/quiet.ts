import * as Effect from 'effect/Effect'

/**
 * Runs work that repeats on its own, with nobody asking, without spans.
 *
 * Two kinds of work are wrapped in this:
 *
 * - A timer's pass: it wakes every few seconds, asks the database whether there is work and
 *   mostly finds none.
 * - A live query's reload: every open subscription reads its session and its data again each time
 *   a topic it watches moves, for as long as the tab is open.
 *
 * Neither is a request, so each one exported a trace of its own: its named steps and every
 * statement under them. On 5 Oct 2026, with one Person using production, that was 119,000 spans
 * an hour before the timers were wrapped and 47,000 after, the rest being reloads.
 *
 * What goes wrong is still told. `observeFailures` writes its log line whether or not a span is
 * open (the line has the failure's type and boundary; it only lacks a trace id), and a Run that a
 * pass starts is recorded as a Run. What is given up is the trace of a pass or a reload that did
 * work; put a span on the work itself where that is wanted.
 *
 * rc.116 `Effect.withTracerEnabled(false)` makes every span beneath it a no-op span, forks
 * included, because the setting is a fiber reference children inherit.
 */
export const untraced = Effect.withTracerEnabled(false)

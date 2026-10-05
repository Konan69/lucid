import * as Effect from 'effect/Effect'

/**
 * Runs a timer's pass without spans.
 *
 * A pass that wakes every few seconds, asks the database whether there is work and finds none is
 * not a thing anyone reads a trace of, yet each one exported its own trace: its named steps and
 * every statement under them. On 5 Oct 2026, with one Person using production, the four timers
 * this wraps were most of 16,000 `sql.execute` spans an hour.
 *
 * What a pass does wrong is still told: `observeFailures` writes its log line whether or not a
 * span is open (the line carries the failure's type and boundary; it only lacks a trace id), and
 * a Run a pass starts is recorded as a Run. What is given up is the trace of a pass that did
 * work; wrap the work itself in a span where that is wanted.
 *
 * rc.116 `Effect.withTracerEnabled(false)` makes every span beneath it a no-op span, forks
 * included, because the setting is a fiber reference children inherit.
 */
export const untracedTimer = Effect.withTracerEnabled(false)

import type {
  Breadcrumb,
  Envelope,
  ErrorEvent,
  Event,
  EventEnvelope,
  EventItem,
  Transport,
} from '@sentry/core'
import { privacy } from '@vivid/state'
import * as Option from 'effect/Option'

/**
 * What an error report may carry to Sentry, for the desktop app's SDK (`@sentry/electron`,
 * built on `@sentry/core` 11.1.0).
 *
 * What may leave is decided in one place for every app: `@vivid/state` `privacy.ts`, an allowlist
 * that builds a new report from the named parts of the one the SDK made. This file is only this
 * SDK's side of it: the hooks typed by this SDK's events, and the guard around its transport,
 * which reads this SDK's envelopes. The apps do not share these few lines, because each is
 * compiled against the `@sentry/core` its own SDK is built on, and the two versions' envelope
 * types differ.
 *
 * This runs in the main process, over its own errors and over every report a window hands it
 * (`telemetry.ts`). It is also where the desktop app's one exception to the shared policy is
 * made: a single sentence its SDK writes may leave as a report's message (`PROCESS_ENDED`).
 *
 * It is enforced twice. `scrub` and `scrubBreadcrumb` are the SDK's `beforeSend` and
 * `beforeBreadcrumb`. `guarded` then wraps the SDK's transport, the one place everything that
 * leaves has to pass: the SDK adds attachments to a report after `beforeSend`, and sends its own
 * internal errors without calling it (`sendEvent` and `_processEvent` in `@sentry/core`
 * `client.js`), so the hooks alone are not the whole way out.
 */

/** The SDK's `beforeBreadcrumb`: a request or a move between screens cut down, or nothing. */
export const scrubBreadcrumb = (from: Breadcrumb): Breadcrumb | null => privacy.breadcrumb(from)

/**
 * The one sentence the SDK writes itself, for a report that is nothing but that sentence: a window
 * or helper process that ended (`getMessageAndSeverity` in `@sentry/electron`
 * `main/integrations/child-process.js`). Both of its blanks are Electron's own words for a
 * process and a reason, so it is the only message that may leave.
 */
const PROCESS_ENDED = /^'[\w -]+' process exited with '[\w-]+'$/u

/**
 * The SDK's `beforeSend`: the report the shared policy builds, which carries no message, and on
 * it every message but the SDK's own (`PROCESS_ENDED`). Without that sentence a report of a
 * window that ended would say nothing at all: it has no exception and no stack.
 *
 * It takes any event and always returns an error report, because `guarded` runs it again over
 * whatever reaches the transport.
 */
export const scrub = (event: Event): ErrorEvent => ({
  ...privacy.report(event),
  message:
    event.message !== undefined && PROCESS_ENDED.test(event.message) ? event.message : undefined,
})

/** Whether an envelope is the kind that carries a report: only that kind has an `event` item. */
const carriesEvent = (envelope: Envelope): envelope is EventEnvelope =>
  envelope[1].some(([header]) => header.type === 'event')

/** Whether one item of such an envelope is the report itself. */
const isEvent = (item: EventEnvelope[1][number]): item is EventItem => item[0].type === 'event'

/**
 * What of an envelope may leave: the error reports in it, each through `scrub` once more, under a
 * header cut to what the shared policy names (`privacy.envelopeHeader`). None when it carries no
 * report.
 *
 * An envelope is how the SDK sends everything, not only errors: sessions, its own counts of what
 * it dropped, replays, profiles, feedback, check-ins, transactions, and the attachments (a
 * screenshot, a view hierarchy) that ride beside a report. All of those are other item types and
 * are left behind here, whatever switched them on.
 */
export const outbound = (envelope: Envelope): Option.Option<EventEnvelope> => {
  if (!carriesEvent(envelope)) return Option.none()
  const [headers, items] = envelope
  const reports: Array<EventItem> = []
  for (const item of items) if (isEvent(item)) reports.push([{ type: 'event' }, scrub(item[1])])
  return Option.some([privacy.envelopeHeader(headers), reports])
}

/**
 * A transport that sends only what `outbound` allows. An envelope with nothing allowed in it is
 * answered as sent, with the empty answer the SDK's own transports give for a request that needs
 * no reply, so the SDK neither retries it nor counts a failure.
 */
export const guarded = (inner: Transport): Transport => ({
  send: (envelope) =>
    Option.match(outbound(envelope), {
      onNone: () => Promise.resolve({}),
      onSome: (kept) => inner.send(kept),
    }),
  flush: (timeout) => inner.flush(timeout),
})

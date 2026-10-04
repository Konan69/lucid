/**
 * Every log message Vivid's own recorders write, as one closed set.
 *
 * A log line's body, and the span event Effect derives from the same line (rc.116
 * `internal/effect.ts` `tracerLogger` names the event by the message), are free text as far as an
 * exporter can tell: a line written anywhere else in the server may quote a Thread, a provider's
 * answer or a client's report. So the export allowlist (`export.ts`) lets a body or an event name
 * through only when it is one of these; a recorder that should be countable in the backend adds
 * its message here and writes that constant, never a template string.
 */
export const Message = {
  /** `failure.ts`: a typed failure was answered at a boundary. */
  failure: 'Failure reached a boundary',
  /** `failure.ts`: a defect was answered at a boundary. */
  defect: 'Defect reached a boundary',
  /** `refusal.ts`: Vivid declined to do something. */
  refusal: 'vivid.refusal',
  /** `http/faults.ts`: a client reported that it failed to draw. */
  fault: 'Client fault',
  /** `export.ts`: an export was cancelled, refused or timed out; its signal is paused a minute. */
  dropped: 'Telemetry batches dropped',
} as const
export type Message = (typeof Message)[keyof typeof Message]

const messages: ReadonlySet<string> = new Set(Object.values(Message))

/** Whether `text` is, exactly, one of the fixed messages. */
export const isMessage = (text: string): text is Message => messages.has(text)

/**
 * A code identifier, optionally dotted: an error's `_tag` or class name, an `Effect.fn` name,
 * `RpcServer.<tag>`. No spaces, quotes, slashes or punctuation, so prose, an address and a
 * statement cannot have this shape; the length bound keeps a generated name from being a payload.
 */
const CODE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const LONGEST_CODE_NAME = 120

/** Whether `text` has the shape of a code identifier and is short enough to be one. */
export const isCodeName = (text: string): boolean =>
  text.length <= LONGEST_CODE_NAME && CODE_NAME.test(text)

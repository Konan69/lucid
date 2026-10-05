import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * The JSON lines Vivid's Windows helper speaks, as typed values.
 *
 * The protocol is the helper's own (`apps/desktop/native/windows/README.md`, "Protocol"): one
 * request per line `{id, method, params, turn?, budget_ms?}`, one reply per request
 * `{id, ok: true, result}` or `{id, error: {name, message}}`, and the unsolicited line
 * `{"event":"stopped","turn":…,"cooldown_ms":…}` when the Person presses Escape. Nothing here
 * runs a process: this module is the vocabulary and the framing, so both are tested without one.
 */

/** A window as the helper names it: the inventory's `{app, id}` pair, sent back unchanged. */
export const HelperWindow = Schema.Struct({ app: Schema.String, id: Schema.String })
export interface HelperWindow extends Schema.Schema.Type<typeof HelperWindow> {}

/**
 * Every request the desktop app makes of the helper. One case per use, not per helper method:
 * `click` by element and `click` at a point are different requests with different authority
 * (README, "Input, stop and budgets"), and so are typing at the keyboard and filling an element.
 */
export const HelperCall = Schema.TaggedUnion({
  BeginTurn: {},
  EndTurn: {},
  Status: {},
  ListApps: {},
  ListWindows: {},
  LaunchApp: { app: Schema.String, id: Schema.String },
  WindowState: { window: HelperWindow },
  ClickElement: { window: HelperWindow, element: Schema.Int },
  ClickPoint: {
    window: HelperWindow,
    x: Schema.Int,
    y: Schema.Int,
    look: Schema.String,
    count: Schema.Literals([1, 2, 3]),
    button: Schema.Literals(['left', 'right']),
  },
  TypeText: { window: HelperWindow, text: Schema.String },
  FillElement: { window: HelperWindow, element: Schema.Int, text: Schema.String },
  PressKey: { window: HelperWindow, key: Schema.String },
  Scroll: {
    window: HelperWindow,
    x: Schema.Int,
    y: Schema.Int,
    look: Schema.String,
    scrollX: Schema.Int,
    scrollY: Schema.Int,
  },
})
export type HelperCall = typeof HelperCall.Type

/**
 * Whether a request can change something on the Person's computer. It decides what a lost reply
 * means: a read that got no answer simply failed, but a change that was written to the pipe may
 * have happened, and is never reported as done, refused or failed (README, "Exit 70 means
 * terminal budget exhaustion with an uncertain input outcome").
 */
export const changes = (call: HelperCall): boolean =>
  HelperCall.match(call, {
    BeginTurn: () => false,
    EndTurn: () => false,
    Status: () => false,
    ListApps: () => false,
    ListWindows: () => false,
    WindowState: () => false,
    LaunchApp: () => true,
    ClickElement: () => true,
    ClickPoint: () => true,
    TypeText: () => true,
    FillElement: () => true,
    PressKey: () => true,
    Scroll: () => true,
  })

/** The helper's own ceiling for one request's budget: 10 s, 15 s for a launch (README, "Budgets"). */
export const budgetCeiling = (call: HelperCall): number =>
  HelperCall.guards.LaunchApp(call) ? 15_000 : 10_000

const Parameters = Schema.Record(Schema.String, Schema.Unknown)

/** The helper's method name and `params` object for a request, exactly as its table lists them. */
const methodOf = (call: HelperCall): { method: string; params: typeof Parameters.Type } =>
  HelperCall.match(call, {
    BeginTurn: () => ({ method: 'begin_turn', params: {} }),
    EndTurn: () => ({ method: 'end_turn', params: {} }),
    Status: () => ({ method: 'status', params: {} }),
    ListApps: () => ({ method: 'list_apps', params: {} }),
    ListWindows: () => ({ method: 'list_windows', params: {} }),
    LaunchApp: ({ app, id }) => ({ method: 'launch_app', params: { app, id } }),
    // Text and picture together: one look is both what Vivid sees and what it may act on.
    WindowState: ({ window }) => ({
      method: 'get_window_state',
      params: { window, include_text: true, include_screenshot: true },
    }),
    ClickElement: ({ window, element }) => ({
      method: 'click',
      params: { window, element_index: element },
    }),
    ClickPoint: ({ window, x, y, look, count, button }) => ({
      method: 'click',
      params: { window, x, y, screenshotId: look, click_count: count, mouse_button: button },
    }),
    TypeText: ({ window, text }) => ({ method: 'type_text', params: { window, text } }),
    FillElement: ({ window, element, text }) => ({
      method: 'type_text',
      params: { window, text, element_index: element },
    }),
    PressKey: ({ window, key }) => ({ method: 'press_key', params: { window, key } }),
    Scroll: ({ window, x, y, look, scrollX, scrollY }) => ({
      method: 'scroll',
      params: { window, x, y, screenshotId: look, scrollX, scrollY },
    }),
  })

/** One request line. `turn` is absent only where the helper allows it: an idle `status`. */
const RequestLine = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Int,
    method: Schema.String,
    params: Parameters,
    turn: Schema.OptionFromOptionalKey(Schema.String),
    budget_ms: Schema.Int,
  }),
)
const encodeRequestLine = Schema.encodeEffect(RequestLine)

/** A request could not be written as a line. Nothing was sent. */
export class RequestUnwritable extends Schema.TaggedError<RequestUnwritable>()(
  'RequestUnwritable',
  {},
  { title: 'The request could not be encoded for the helper' },
) {}

/** Encodes one request as its line, without the newline. */
export const requestLine = (input: {
  readonly id: number
  readonly call: HelperCall
  readonly turn: Option.Option<string>
  readonly budget: number
}) => {
  const { method, params } = methodOf(input.call)
  return encodeRequestLine({
    id: input.id,
    method,
    params,
    turn: input.turn,
    budget_ms: input.budget,
  }).pipe(Effect.mapError(() => new RequestUnwritable({})))
}

/**
 * What came back for one request.
 *
 * - `Answered`: the helper did it. `result` is still unknown here; whoever asked decodes it with
 *   the schema of the method they called.
 * - `Refused`: the helper's `{error: {name}}`. `delivered` is present only for
 *   `TypingInterrupted`, with the name of what interrupted it in `reason`.
 * - `Lost`: no reply will come: the process ended (exit 70 included), its output was not a line
 *   of this protocol, or the desktop's own watchdog gave up on it. `sent` says whether the
 *   request had been written to the pipe, which is what makes a change's outcome unknown.
 */
export const HelperReply = Schema.TaggedUnion({
  Answered: { result: Schema.Unknown },
  Refused: {
    name: Schema.String,
    delivered: Schema.Option(Schema.Int),
    reason: Schema.Option(Schema.String),
  },
  Lost: { sent: Schema.Boolean },
})
export type HelperReply = typeof HelperReply.Type

/** One line from the helper's stdout, decoded: a reply to a numbered request, or the stop event. */
export const HelperLine = Schema.TaggedUnion({
  Reply: { id: Schema.Int, reply: HelperReply },
  Stopped: { turn: Schema.String, cooldown: Schema.Int },
})
export type HelperLine = typeof HelperLine.Type

const SuccessLine = Schema.Struct({
  id: Schema.Int,
  ok: Schema.Literal(true),
  result: Schema.Unknown,
})
const FailureLine = Schema.Struct({
  id: Schema.Int,
  error: Schema.Struct({
    name: Schema.String,
    delivered: Schema.OptionFromOptionalKey(Schema.Int),
    reason: Schema.OptionFromOptionalKey(Schema.String),
  }),
})
const StoppedLine = Schema.Struct({
  event: Schema.Literal('stopped'),
  turn: Schema.String,
  cooldown_ms: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 })),
})
const decodeSuccess = Schema.decodeUnknownOption(Schema.fromJsonString(SuccessLine))
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(FailureLine))
const decodeStopped = Schema.decodeUnknownOption(Schema.fromJsonString(StoppedLine))

/**
 * Decodes one stdout line, once, at the ingress. Nothing means the line is not this protocol:
 * the helper is then treated as gone, because a reply can no longer be matched to its request.
 * The helper's `message` text is deliberately not kept: the name alone decides what happens.
 */
export const decodeLine = (text: string): Option.Option<HelperLine> =>
  Option.orElse(
    Option.map(decodeSuccess(text), ({ id, result }) =>
      HelperLine.cases.Reply.make({ id, reply: HelperReply.cases.Answered.make({ result }) }),
    ),
    () =>
      Option.orElse(
        Option.map(decodeFailure(text), ({ id, error }) =>
          HelperLine.cases.Reply.make({ id, reply: HelperReply.cases.Refused.make(error) }),
        ),
        () =>
          Option.map(decodeStopped(text), (stopped) =>
            HelperLine.cases.Stopped.make({ turn: stopped.turn, cooldown: stopped.cooldown_ms }),
          ),
      ),
  )

/**
 * The longest line the helper may send: its own cap for a response is 32 MiB of UTF-8 (README,
 * "Responses exceeding 32 MiB UTF-8 return `ResponseTooLarge`"). A line longer than that is not
 * the helper keeping its own rule, so it is not read further.
 */
export const LINE_LIMIT_BYTES = 32 * 1024 * 1024

/** What the framer found in the bytes so far. */
export const Framed = Schema.TaggedUnion({
  Line: { text: Schema.String },
  /** More than the limit arrived with no end of line. The stream cannot be trusted after it. */
  TooLong: {},
})
export type Framed = typeof Framed.Type

/**
 * Cuts a byte stream into lines. Chunks arrive at any boundary, so the bytes of an unfinished
 * line are held until its newline comes; a line is decoded as UTF-8 only once it is whole, which
 * keeps a character split across two chunks intact. After `TooLong` it yields nothing more.
 */
export function lineFramer(limit: number) {
  let held: Array<Buffer> = []
  let size = 0
  let broken = false
  return (chunk: Buffer): ReadonlyArray<Framed> => {
    if (broken) return []
    const found: Array<Framed> = []
    let rest = chunk
    for (let end = rest.indexOf(10); end !== -1; end = rest.indexOf(10)) {
      held.push(rest.subarray(0, end))
      const text = Buffer.concat(held).toString('utf8')
      found.push(Framed.cases.Line.make({ text: text.endsWith('\r') ? text.slice(0, -1) : text }))
      held = []
      size = 0
      rest = rest.subarray(end + 1)
    }
    held.push(rest)
    size += rest.length
    if (size > limit) {
      broken = true
      held = []
      found.push(Framed.cases.TooLong.make({}))
    }
    return found
  }
}

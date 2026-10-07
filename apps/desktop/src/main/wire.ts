import * as Effect from 'effect/Effect'
import * as NodeFS from 'node:fs'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * The JSON lines the Computer supervisor (the vendored Windows binary, `vendor/computer/`) speaks,
 * as typed values, and Vivid's requests of it.
 *
 * The protocol is the supervisor's own (see `vendor/computer/README.md`, "How the desktop app
 * uses them"): one request per line `{id, method, params, meta?}` — `meta` carries the turn
 * (`x-codex-turn-metadata`) and the request's budget in milliseconds
 * (`x-oai-cua-request-budget-ms`) — and one reply per request `{id, ok: true, result}` or
 * `{id, ok: false, approvalRequest: …}` or `{id, error: "<message>"}`. A reply that asks for an
 * app approval is answered by the desktop itself (nothing is ever asked of the Person here), so
 * it is decoded as its own line kind (`Approval`), never shown as a refusal.
 *
 * Two calls never reach the wire: `BeginTurn` and `Status`. The supervisor has no turn-begin
 * method — a turn is the `meta` on each request, ended by `end_turn` — and no status method.
 * Both are answered locally by the desktop (`computer.ts`); the turn really begins with the
 * first request of the work.
 */

/** A window as Vivid carries it: the inventory's `{app, id}` pair, sent back unchanged. */
export const ComputerWindow = Schema.Struct({ app: Schema.String, id: Schema.String })
export interface ComputerWindow extends Schema.Schema.Type<typeof ComputerWindow> {}

/**
 * Every request the desktop app makes of the Computer. One case per use, not per supervisor
 * method: `click` by element and `click` at a point are different requests with different
 * authority, and so are typing at the keyboard and filling an element.
 */
export const ComputerCall = Schema.TaggedUnion({
  BeginTurn: {},
  EndTurn: {},
  Status: {},
  ListApps: {},
  ListWindows: {},
  LaunchApp: { app: Schema.String, id: Schema.String },
  WindowState: { window: ComputerWindow },
  ClickElement: { window: ComputerWindow, element: Schema.Int },
  ClickPoint: {
    window: ComputerWindow,
    x: Schema.Int,
    y: Schema.Int,
    look: Schema.String,
    count: Schema.Literals([1, 2, 3]),
    button: Schema.Literals(['left', 'right']),
  },
  TypeText: { window: ComputerWindow, text: Schema.String },
  FillElement: { window: ComputerWindow, element: Schema.Int, text: Schema.String },
  PressKey: { window: ComputerWindow, key: Schema.String },
  Scroll: {
    window: ComputerWindow,
    x: Schema.Int,
    y: Schema.Int,
    look: Schema.String,
    scrollX: Schema.Int,
    scrollY: Schema.Int,
  },
})
export type ComputerCall = typeof ComputerCall.Type

/**
 * Whether a request can change something on the Person's computer. It decides what a lost reply
 * means: a read that got no answer simply failed, but a change that was written to the pipe may
 * have happened, and is never reported as done, refused or failed.
 */
export const changes = (call: ComputerCall): boolean =>
  ComputerCall.match(call, {
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

/**
 * Whether the request reaches the wire at all: `BeginTurn` and `Status` are answered by the
 * desktop itself, because the supervisor has no such methods (module comment).
 */
export const reachesWire = (call: ComputerCall): boolean =>
  ComputerCall.match(call, {
    BeginTurn: () => false,
    Status: () => false,
    EndTurn: () => true,
    ListApps: () => true,
    ListWindows: () => true,
    LaunchApp: () => true,
    WindowState: () => true,
    ClickElement: () => true,
    ClickPoint: () => true,
    TypeText: () => true,
    FillElement: () => true,
    PressKey: () => true,
    Scroll: () => true,
  })

/**
 * The supervisor's own ceiling for one request's budget, in milliseconds: 15 s for a launch,
 * 10 s for everything else (the reference client's two timeouts). The desktop's watchdog waits a
 * little past this, then stops the process (`computer.ts`).
 */
export const budgetCeiling = (call: ComputerCall): number =>
  ComputerCall.guards.LaunchApp(call) ? 15_000 : 10_000

/**
 * The window as the supervisor's methods take it: `id` is an integer (`"id must be an integer
 * >= 0"`). Vivid carries ids as strings (`Table`, `windows.ts`), so the number comes back here,
 * at the one edge. An id that is not a whole number is sent as it is: the supervisor refuses it
 * with its own error, and a refusal is an honest answer.
 */
const wireWindow = (window: ComputerWindow): { app?: string; id: number | string } => {
  const id = Number(window.id)
  return Number.isInteger(id) && id >= 0
    ? { app: window.app, id }
    : { app: window.app, id: window.id }
}

/**
 * The supervisor's method name and `params` for a request, exactly as its methods take them
 * (`vendor/computer/README.md`):
 * - `launch_app` takes the inventory id (`{app}`), which is what `Open` carries as its `id`;
 * - a click on an element is the `click_element` method, a click at a point is `click` with
 *   `x`/`y` and the look's screenshot id, which is how the point's pixels become screen
 *   coordinates;
 * - filling an element is `set_value`: the element's own way of taking text, not keystrokes;
 * - scrolling is in wheel units, 120 a notch (`windows.ts`), with the same screenshot id.
 */
/**
 * The turn metadata the supervisor reads, exactly the reference's own shape: one JSON object of
 * `session_id` and `turn_id` under `x-codex-turn-metadata`, both id characters only, and the
 * budget under `x-oai-cua-request-budget-ms` (the reference's `meta` keys). The session and the
 * turn are the same Run here: the supervisor keys its Escape-interrupt markers by the pair.
 */
const metaOf = (turn: string, budget: number) => {
  const id = turn.replace(/[^A-Za-z0-9._-]/g, '_')
  return {
    'x-codex-turn-metadata': JSON.stringify({ session_id: id, turn_id: id }),
    'x-oai-cua-request-budget-ms': budget,
    // The supervisor's own escape hatch for its browser guard, in the request's meta — with
    // the whole computer allowed, the browser is allowed too.
    'x-codex-browser-use-security-mode': 'disabled-for-local-testing',
  }
}

/**
 * One request line. `reachesWire` says which calls this is for; the desktop answers the others
 * itself, without a line.
 */
const RequestLine = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Int,
    method: Schema.String,
    params: Schema.Record(Schema.String, Schema.Unknown),
    meta: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const encodeRequestLine = Schema.encodeEffect(RequestLine)

/** A request could not be written as a line. Nothing was sent. */
export class RequestUnwritable extends Schema.TaggedError<RequestUnwritable>()(
  'RequestUnwritable',
  {},
  { title: 'The request could not be encoded for the Computer' },
) {}

/**
 * One request as the supervisor takes it: the envelope with its `meta`, and — when the desktop
 * is answering an approval ask — the approved app added to that `meta`, exactly the reference
 * client's own answer. Built as a value first, so an approval re-sends the same request without
 * re-parsing anything.
 *
 * The supervisor's method name and `params` for a request, exactly as its methods take them
 * (`vendor/computer/README.md`):
 * - `launch_app` takes the inventory id (`{app}`), which is what `Open` carries as its `id`;
 * - a click on an element is the `click_element` method, a click at a point is `click` with
 *   `x`/`y` and the look's screenshot id, which is how the point's pixels become screen
 *   coordinates;
 * - filling an element is `set_value`: the element's own way of taking text, not keystrokes;
 * - scrolling is in wheel units, 120 a notch (`windows.ts`), with the same screenshot id.
 */
const requestObject = (input: {
  readonly id: number
  readonly call: ComputerCall
  readonly turn: Option.Option<string>
  readonly budget: number
  readonly approvedApp: Option.Option<string>
}) => {
  const meta = Option.match(input.turn, {
    onNone: () => ({}),
    onSome: (turn) => metaOf(turn, input.budget),
  })
  const withApproval = Option.match(input.approvedApp, {
    onNone: () => meta,
    onSome: (app) => ({ ...meta, 'x-oai-cua-approved-app': app }),
  })
  return ComputerCall.match(input.call, {
    BeginTurn: () => ({ id: input.id, method: '', params: {}, meta: withApproval }),
    EndTurn: () => ({ id: input.id, method: 'end_turn', params: {}, meta: withApproval }),
    Status: () => ({ id: input.id, method: '', params: {}, meta: withApproval }),
    ListApps: () => ({ id: input.id, method: 'list_apps', params: {}, meta: withApproval }),
    ListWindows: () => ({ id: input.id, method: 'list_windows', params: {}, meta: withApproval }),
    LaunchApp: ({ app, id }) => ({
      id: input.id,
      method: 'launch_app',
      params: { app: id || app },
      meta: withApproval,
    }),
    // Text and picture together: one look is both what Vivid sees and what it may act on.
    WindowState: ({ window }) => ({
      id: input.id,
      method: 'get_window_state',
      params: { window: wireWindow(window), include_text: true, include_screenshot: true },
      meta: withApproval,
    }),
    ClickElement: ({ window, element }) => ({
      id: input.id,
      method: 'click_element',
      params: { window: wireWindow(window), element_index: element, click_count: 1 },
      meta: withApproval,
    }),
    ClickPoint: ({ window, x, y, look, count, button }) => ({
      id: input.id,
      method: 'click',
      params: {
        window: wireWindow(window),
        x,
        y,
        screenshotId: look,
        click_count: count,
        mouse_button: button,
      },
      meta: withApproval,
    }),
    TypeText: ({ window, text }) => ({
      id: input.id,
      method: 'type_text',
      params: { window: wireWindow(window), text },
      meta: withApproval,
    }),
    FillElement: ({ window, element, text }) => ({
      id: input.id,
      method: 'set_value',
      params: { window: wireWindow(window), element_index: element, value: text },
      meta: withApproval,
    }),
    PressKey: ({ window, key }) => ({
      id: input.id,
      method: 'press_key',
      params: { window: wireWindow(window), key },
      meta: withApproval,
    }),
    Scroll: ({ window, x, y, look, scrollX, scrollY }) => ({
      id: input.id,
      method: 'scroll',
      params: { window: wireWindow(window), x, y, screenshotId: look, scrollX, scrollY },
      meta: withApproval,
    }),
  })
}

/** Encodes one request as its line, without the newline. Empty for a call that stays local. */
export const requestLine = (input: {
  readonly id: number
  readonly call: ComputerCall
  readonly turn: Option.Option<string>
  readonly budget: number
  /** Set only when re-sending a request the supervisor answered with an approval ask. */
  readonly approvedApp: Option.Option<string>
}): Effect.Effect<string, RequestUnwritable> => {
  if (!reachesWire(input.call)) return Effect.succeed('')
  return encodeRequestLine(requestObject(input)).pipe(
    Effect.mapError(() => new RequestUnwritable({})),
  )
}

/**
 * What came back for one request.
 *
 * - `Answered`: the Computer did it. `result` is still unknown here; whoever asked decodes it
 *   with the schema of the method they called.
 * - `Refused`: the supervisor's `error` message. The message is kept as the `name`: every error
 *   the supervisor raises is one string, and the name alone decides what the refusal means
 *   (`windows.ts`). `delivered` and `reason` are always absent — the supervisor does not send
 *   partial typing counts; they stay in the vocabulary so the typing rule keeps its shape.
 * - `Lost`: no reply will come: the process ended, its output was not a line of this protocol,
 *   or the desktop's own watchdog gave up on it. `sent` says whether the request had been
 *   written, which is what makes a change's outcome unknown.
 */
export const ComputerReply = Schema.TaggedUnion({
  Answered: { result: Schema.Unknown },
  Refused: {
    name: Schema.String,
    delivered: Schema.Option(Schema.Int),
    reason: Schema.Option(Schema.String),
  },
  Lost: { sent: Schema.Boolean },
})
export type ComputerReply = typeof ComputerReply.Type

/**
 * One line from the supervisor's stdout: a reply to a numbered request, or an approval ask. The
 * approval ask is not shown to anyone — the desktop answers it itself, at once, by re-sending
 * the request with the approved app in its `meta` (the reference client's own answer after a
 * Person allows an app; here no Person is ever asked).
 */
export const ComputerLine = Schema.TaggedUnion({
  Reply: { id: Schema.Int, reply: ComputerReply },
  Approval: { id: Schema.Int, app: Schema.String },
  Stopped: { turn: Schema.String, cooldown: Schema.Int },
})
export type ComputerLine = typeof ComputerLine.Type

const SuccessLine = Schema.Struct({
  id: Schema.Int,
  ok: Schema.Literal(true),
  result: Schema.Unknown,
})
const ApprovalLine = Schema.Struct({
  id: Schema.Int,
  ok: Schema.Literal(false),
  approvalRequest: Schema.Struct({
    app: Schema.String,
    displayName: Schema.optionalKey(Schema.String),
    riskLevel: Schema.optionalKey(Schema.Literals(['high', 'low'])),
    allowPersistentApproval: Schema.optionalKey(Schema.Boolean),
  }),
})
const FailureLine = Schema.Struct({
  id: Schema.Int,
  ok: Schema.Literal(false),
  error: Schema.String,
})
const decodeSuccess = Schema.decodeUnknownOption(Schema.fromJsonString(SuccessLine))
const decodeApproval = Schema.decodeUnknownOption(Schema.fromJsonString(ApprovalLine))
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(FailureLine))

/**
 * Decodes one stdout line, once, at the ingress. Nothing means the line is not this protocol:
 * the supervisor is then treated as gone, because a reply can no longer be matched to its
 * request. The error message text is kept only as the name the refusal rules read.
 */
export const decodeLine = (text: string): Option.Option<ComputerLine> =>
  Option.orElse(
    Option.map(decodeSuccess(text), ({ id, result }) =>
      ComputerLine.cases.Reply.make({
        id,
        reply: ComputerReply.cases.Answered.make({ result }),
      }),
    ),
    () =>
      Option.orElse(
        Option.map(decodeApproval(text), ({ id, approvalRequest }) =>
          ComputerLine.cases.Approval.make({ id, app: approvalRequest.app }),
        ),
        () =>
          Option.map(decodeFailure(text), ({ id, error }) =>
            ComputerLine.cases.Reply.make({
              id,
              reply: ComputerReply.cases.Refused.make({
                name: error,
                delivered: Option.none(),
                reason: Option.none(),
              }),
            }),
          ),
      ),
  )

/**
 * The supervisor's Escape message, as its client transport raises it for a request in a turn the
 * Person stopped: the whole message begins with this opening. It is both what an in-flight request
 * is refused with when the process ends 130, and what a later request in that turn gets (mock and
 * reference alike), so both files that read refusals match on its opening (see `windows.ts`).
 */
export const ESCAPE_STOPPED = 'Computer Use was stopped by the user with the physical Escape key'

/**
 * The picture of one look, as the supervisor sends it: a `url` that is either a PNG data URL or
 * a path to a PNG on this computer. Vivid carries the PNG itself, base64, so both shapes are
 * decoded here, once, at the ingress. Anything else is not a picture: `None`.
 */
export const screenshotPng = (url: string): Effect.Effect<Option.Option<string>> => {
  const prefix = 'data:image/png;base64,'
  if (url.startsWith(prefix)) return Effect.succeedSome(url.slice(prefix.length))
  if (!/^[A-Za-z]:[\\/]/.test(url) && !url.startsWith('\\\\')) return Effect.succeedNone
  // A file that cannot be read is not a picture: the failure is folded into the `None`.
  return Effect.sync(Option.liftThrowable(() => NodeFS.readFileSync(url).toString('base64')))
}

/**
 * The longest line the supervisor may send: the reference client's own response allowance is 32
 * MiB of UTF-8, and a whole window state with its picture fits well under it. A line longer than
 * that is not the supervisor keeping its own rule, so it is not read further.
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

// A stand-in for Vivid's Windows helper (apps/desktop/native/windows), for the tests beside it.
// The real helper is a native Windows program these tests cannot run; this speaks the same JSON
// lines (its README, "Protocol") and keeps the same turn rules, so the desktop app's side of the
// protocol is exercised against a real child process with real pipes. It touches nothing: every
// window and app here is made up. The text of a `type_text` request chooses what goes wrong.
import * as NodeProcess from 'node:process'
import * as NodeReadline from 'node:readline'
import * as Schema from 'effect/Schema'

let active = null
const stopped = new Set()
let escapeAfterLook = false
let looks = 0

const send = (value) => NodeProcess.stdout.write(`${JSON.stringify(value)}\n`)
const fail = (id, name, extra = {}) => send({ id, error: { name, message: 'refused', ...extra } })
const ok = (id, result) => send({ id, ok: true, result })
const escape = () => {
  const turn = active
  stopped.add(turn)
  active = null
  send({ event: 'stopped', turn, cooldown_ms: 0 })
}

const window = { app: 'notepad', id: 'session:1A:2B:3C:Notepad' }

/** What typing does, chosen by the text typed. */
const typed = (id, text) => {
  if (text === 'hang') return undefined
  if (text === 'exit70') return NodeProcess.exit(70)
  if (text === 'garbage') return NodeProcess.stdout.write('this is not the protocol\n')
  if (text === 'partial')
    return fail(id, 'TypingInterrupted', { delivered: 3, reason: 'NativeInputFailed' })
  if (text === 'unsent')
    return fail(id, 'TypingInterrupted', { delivered: 0, reason: 'ForegroundRefused' })
  if (text === 'hooks') return fail(id, 'HookUnavailable')
  if (text === 'native') return fail(id, 'NativeInputFailed')
  if (text === 'elevated') return fail(id, 'ElevatedTarget')
  if (text === 'escape') {
    escape()
    return fail(id, 'PersonStopped')
  }
  if (text === 'escape later') escapeAfterLook = true
  return ok(id, {})
}

/** An exact Alt+F4 closes; Ctrl+W stands for an app that asks before closing. */
const pressed = (key) => {
  if (key === 'Alt+F4') return { outcome: 'closed' }
  if (key === 'Ctrl+W') return { outcome: 'closePending', dialogClass: null }
  return {}
}

const methods = {
  status: ({ id }) => ok(id, { phase: active === null ? 'Idle' : 'Active', hooksLive: true }),
  list_apps: ({ id }) =>
    ok(id, {
      apps: [
        { name: 'Notepad', id: 'machine:Notepad.lnk', source: 'machine', launchable: true },
        { name: 'Terminal', id: 'machine:Terminal.lnk', source: 'machine', launchable: true },
        { name: '', id: 'machine:Nameless.lnk', source: 'machine', launchable: true },
      ],
      skipped: 2,
    }),
  launch_app: ({ id, params }) => ok(id, { pid: 7, app: params.app, id: params.id }),
  list_windows: ({ id }) =>
    ok(id, [{ ...window, pid: 43, title: 'Untitled - Notepad', inputAccess: 'Allowed' }]),
  get_window_state: ({ id }) => {
    looks += 1
    ok(id, {
      window,
      text: '0 Window "Untitled - Notepad"\n1 Edit "Text editor"',
      truncated: false,
      screenshot: { id: `look${looks}`, width: 800, height: 600, png: 'iVBORw0KGgo=', scale: 1 },
      origin: { x: 0, y: 0 },
    })
    if (escapeAfterLook) {
      escapeAfterLook = false
      escape()
    }
  },
  click: ({ id, params }) =>
    'screenshotId' in params && params.screenshotId !== `look${looks}`
      ? fail(id, 'ScreenshotStale')
      : ok(id, {}),
  scroll: ({ id }) => ok(id, {}),
  type_text: ({ id, params }) => typed(id, params.text),
  press_key: ({ id, params }) => ok(id, pressed(params.key)),
}

const handle = (request) => {
  const { id, method, turn } = request
  if (method === 'begin_turn') {
    if (stopped.has(turn)) return fail(id, 'PersonStopped')
    if (active !== null && active !== turn) return fail(id, 'TurnMismatch')
    active = turn
    return ok(id, { active: true })
  }
  if (active !== null && turn !== active) return fail(id, 'TurnMismatch')
  if (method === 'end_turn') {
    active = null
    return ok(id, { active: false })
  }
  if (method === 'status') return methods.status(request)
  if (active === null) return fail(id, stopped.has(turn) ? 'PersonStopped' : 'NoActiveTurn')
  const known = methods[method]
  return known === undefined ? fail(id, 'UnknownMethod') : known(request)
}

NodeProcess.stderr.write('fake helper started\n')
const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Int,
    method: Schema.String,
    params: Schema.Record(Schema.String, Schema.Unknown),
    turn: Schema.optionalKey(Schema.String),
  }),
)
const decodeRequest = Schema.decodeUnknownSync(Request)
NodeReadline.createInterface({ input: NodeProcess.stdin }).on('line', (line) =>
  handle(decodeRequest(line)),
)

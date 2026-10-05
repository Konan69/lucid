// A stand-in for Vivid's Computer supervisor (vendor/computer/), for the tests beside it.
// The real supervisor is a vendored Windows binary these tests cannot run; this speaks the same
// JSON lines (`vendor/computer/README.md`, "How the desktop app uses them") and keeps the same
// approval and stop rules, so the desktop app's side of the protocol is exercised against a real
// child process with real pipes. It touches nothing: every window and app here is made up. The
// text of a `type_text` or `launch_app` request chooses what goes wrong.
import * as NodeProcess from 'node:process'
import * as NodeReadline from 'node:readline'
import * as Schema from 'effect/Schema'

const ESCAPE = 'Computer Use was stopped by the user with the physical Escape key. Stop your work.'
let approvalOnce = false
let escapeAfterLook = false
let looks = 0

const send = (value) => NodeProcess.stdout.write(`${JSON.stringify(value)}\n`)
const ok = (id, result) => send({ id, ok: true, result })
const fail = (id, message) => send({ id, ok: false, error: message })
const approve = (id, app) =>
  send({ id, ok: false, approvalRequest: { app, displayName: app, allowPersistentApproval: true } })

const window = { app: 'notepad', id: 7 }

/** What typing does, chosen by the text typed. */
const typed = (id, text) => {
  if (text === 'hang') return undefined
  if (text === 'exit70') return NodeProcess.exit(70)
  if (text === 'garbage') return NodeProcess.stdout.write('this is not the protocol\n')
  if (text === 'native') return fail(id, 'NativeInputFailed')
  if (text === 'elevated') return fail(id, 'ElevatedTarget')
  if (text === 'unsent') return fail(id, 'InvalidRequest')
  if (text === 'escape') {
    NodeProcess.exit(130)
  }
  if (text === 'escape later') escapeAfterLook = true
  return ok(id, {})
}

const methods = {
  list_apps: (id) =>
    ok(id, [
      { id: 'Microsoft.Notepad_8wekyb3d8bbwe!App', displayName: 'Notepad' },
      { id: 'machine:Terminal.lnk' },
      { id: 'machine:Nameless.lnk', displayName: '' },
    ]),
  launch_app: (id, params) => {
    if (params.app === 'unknown.app') return fail(id, 'app is not in the inventory')
    if (params.app === 'approval.app') {
      if (!approvalOnce) {
        approvalOnce = true
        return send({ id, ok: false, approvalRequest: { app: params.app, displayName: 'Approval' } })
      }
      return ok(id, {})
    }
    return ok(id, {})
  },
  list_windows: (id) => ok(id, [{ ...window, title: 'Untitled - Notepad' }]),
  get_window_state: (id) => {
    looks += 1
    ok(id, {
      window,
      screenshots: [
        { id: `look${looks}`, url: 'data:image/png;base64,iVBORw0KGgo=', width: 800, height: 600 },
      ],
      accessibility: {
        tree: '0 Window "Untitled - Notepad"\n1 Edit "Text editor"',
        focused_element: 1,
      },
    })
    // Escape just after this action's own answer: the work is done, then the Person stops.
    if (escapeAfterLook) {
      escapeAfterLook = false
      setImmediate(() => NodeProcess.exit(130))
    }
  },
  click: (id, params) =>
    'screenshotId' in params && params.screenshotId !== `look${looks}`
      ? fail(id, 'the screenshot id is stale')
      : ok(id, {}),
  click_element: (id) => ok(id, {}),
  scroll: (id) => ok(id, {}),
  set_value: (id) => ok(id, {}),
  type_text: (id, params) => typed(id, params.text),
  press_key: (id) => send({ id, ok: true, result: null }),
  end_turn: (id) => ok(id, {}),
}

const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Int,
    method: Schema.String,
    params: Schema.Record(Schema.String, Schema.Unknown),
    meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
const decodeRequest = Schema.decodeUnknownSync(Request)

NodeProcess.stderr.write('fake Computer started\n')
NodeReadline.createInterface({ input: NodeProcess.stdin }).on('line', (line) => {
  const request = decodeRequest(line)

  if (request.method === 'end_turn') return methods.end_turn(request.id)
  const known = methods[request.method]
  return known === undefined ? fail(request.id, 'unknown method') : known(request.id, request.params)
})


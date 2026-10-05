// The program runner. It is the only file of the server that runs on a Person's Computer, so it
// uses nothing but Node 24: the server sends this text as it is and starts it there with
// `node <this file> <directory> <result bytes> <log characters> <heap MiB>`.
//
// The Computer is where a program runs (5 October 2026). There is no interpreter inside the
// interpreter and no second sandbox: the program is JavaScript in a worker thread of this process,
// with the Computer's files, network and Node modules. What it cannot do by itself is act for the
// Person: every tool call is printed for the server, which checks it as the Person and answers.
//
// The surface a program sees (`tools`, `accounts`, `text`, `console`, an async function body whose
// `return` is the result) is the one of pi's code mode, which this replaces
// (`@earendil-works/pi-codemode` 1.0.0, README "Usage" and `runtime/prelude-source.js`). The
// messages are the server's `protocol.ts`: one JSON value per line on standard output going out
// (Call, Done, Failed), one file holding one JSON line coming in (Start, Reply, Cancel). Boat can
// follow what a command prints but cannot write to it, which is why answers arrive as files.
//
// The rules switched off below are the server's rules for Effect code. None of them can be met
// here: this file has no Effect and no Schema to meet them with, because it must run on a
// Computer that has Node and nothing of Vivid's. `postMessage` is a worker thread's, which has no
// target origin.
/* oxlint-disable vivid/no-promise-constructor, vivid/no-try-catch, vivid/require-schema-decode-in-boundary, anti-slop/no-runtime-typeof, anti-slop-effect/no-manual-tagged-construction, anti-slop-effect/no-manual-tag-comparison, unicorn/require-post-message-target-origin */
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeWorkerThreads from 'node:worker_threads'

/** Longest wait for the program text. A server that died after starting this must not leave it. */
const START_SECONDS = 60

/**
 * The program's side. It runs in a worker thread so that the thread above stays free to hear
 * Cancel while the program spins, and so that the heap limit ends the program and not the runner.
 */
function program() {
  const port = NodeWorkerThreads.parentPort
  const waiting = new Map()
  let next = 0
  port.on('message', (reply) => {
    const resolve = waiting.get(reply.id)
    if (resolve === undefined) return
    waiting.delete(reply.id)
    if (waiting.size === 0) port.unref()
    resolve(reply.value)
  })
  // The port must not keep the thread alive by itself: a program that awaits something nothing
  // can settle then ends, and is reported, where it would otherwise hang until the deadline.
  // Adding the listener above took a reference (Node `worker_threads`, `port.ref()`), so this
  // comes after it; a call takes the reference back for as long as it waits.
  port.unref()
  /** Arguments make a JSON round trip, as in pi: what cannot be JSON rejects the call. */
  const call = (kind) => (input) => {
    const text = JSON.stringify(input)
    if (text === undefined) return Promise.reject(new TypeError('Tool input must be JSON.'))
    const id = ++next
    return new Promise((resolve) => {
      waiting.set(id, resolve)
      port.ref()
      port.postMessage({ type: 'call', id, kind, text })
    })
  }
  const tools = Object.freeze(
    Object.fromEntries(NodeWorkerThreads.workerData.kinds.map((kind) => [kind, call(kind)])),
  )
  // Accounts and their tools are named by exact strings the Person chose. `then` must be absent on
  // both proxies, or awaiting one would call it. Every call goes through `use_tool`, so it meets
  // the same check as a call the model makes alone.
  const accounts = new Proxy(
    {},
    {
      get(_target, account) {
        if (account === 'then' || String(account) !== account) return undefined
        return new Proxy(
          {},
          {
            get(_inner, tool) {
              if (tool === 'then' || String(tool) !== tool) return undefined
              return (input, about) => {
                if (about === undefined || about === null)
                  throw new Error(
                    'Integration calls require a second argument with summary and rationale.',
                  )
                return tools.use_tool({
                  account,
                  tool,
                  input,
                  summary: about.summary,
                  rationale: about.rationale,
                })
              }
            },
          },
        )
      },
    },
  )
  /** One printed line. Values other than strings are shown as JSON, as pi's `text` does. */
  const shown = (value) => {
    if (typeof value === 'string') return value
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  }
  const text = (value) => port.postMessage({ type: 'log', text: shown(value) })
  const line = (...values) => text(values.map(shown).join(' '))
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = line
  // The opening stays on the program's first line, so a stack trace names the line the model
  // wrote. Evaluating the text is this file's whole purpose. It is the indirect form: the program
  // sees the thread's globals and none of this function's names, and `import()` inside it works
  // as it does in any module (the `node:vm` way needs a loader Node still marks experimental,
  // whose warning would be printed into every program's output).
  const opening = '(async (tools, accounts, text) => {'
  let body
  try {
    // oxlint-disable-next-line no-eval -- Running the program the model wrote is what this runner is for.
    body = (0, eval)(`${opening}${NodeWorkerThreads.workerData.code}\n})\n//# sourceURL=program.js`)
  } catch (error) {
    port.postMessage({ type: 'threw', message: said(error) })
    return
  }
  body(tools, accounts, text).then(
    (value) => {
      const json = JSON.stringify(value === undefined ? null : value)
      if (json === undefined)
        port.postMessage({ type: 'threw', message: 'Program result cannot be serialized as JSON.' })
      else port.postMessage({ type: 'done', text: json })
    },
    (error) => port.postMessage({ type: 'threw', message: said(error) }),
  )
}

/** What a thrown value says, bounded. A thrown value need not be an Error. */
function said(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
}

/** The runner's side: the messages, the files that answer them, and the end of the program. */
function runner() {
  const [directory, resultBytes, logCharacters, heap] = process.argv.slice(2)
  const inbox = NodePath.join(directory, 'in')
  const limits = { result: Number(resultBytes), logs: Number(logCharacters), heap: Number(heap) }
  const logs = []
  let kept = 0
  let logsTruncated = false
  let worker
  let finished = false
  const print = (line) => process.stdout.write(`${line}\n`)
  /** Lines past the allowance are dropped here; the server fits what is kept to its exact bytes. */
  const keep = (line) => {
    if (logsTruncated) return
    if (kept + line.length <= limits.logs) {
      logs.push(line)
      kept += line.length
      return
    }
    logsTruncated = true
    let prefix = ''
    // Whole code points only: half a surrogate pair is not text.
    for (const character of line) {
      if (kept + prefix.length + character.length > limits.logs) break
      prefix += character
    }
    logs.push(prefix)
  }
  /** Exactly one final message; then nothing of the program is left on the Computer. */
  const finish = (message) => {
    if (finished) return
    finished = true
    clearTimeout(unstarted)
    watcher.close()
    print(JSON.stringify({ ...message, logs, logsTruncated }))
    NodeFS.rmSync(directory, { recursive: true, force: true })
    // The program may have left timers, sockets or child processes; none of them outlives it.
    if (worker === undefined) process.exit(0)
    else worker.terminate().then(() => process.exit(0))
  }
  const failed = (failure) => finish({ _tag: 'Failed', failure })
  const start = (code) => {
    clearTimeout(unstarted)
    worker = new NodeWorkerThreads.Worker(new URL(import.meta.url), {
      workerData: { code, kinds: ['find_tools', 'use_tool', 'run_command', 'browse', 'read_page'] },
      resourceLimits: { maxOldGenerationSizeMb: limits.heap },
      // What the program writes to its own output is not a message and must not become one.
      stdout: true,
      stderr: true,
    })
    worker.on('message', (message) => {
      if (finished) return
      if (message.type === 'log') keep(message.text)
      // The input is already JSON text; it is placed in the line as it is, never parsed here.
      else if (message.type === 'call')
        print(`{"_tag":"Call","id":${message.id},"kind":"${message.kind}","input":${message.text}}`)
      else if (message.type === 'threw') failed({ _tag: 'Threw', message: message.message })
      else if (Buffer.byteLength(message.text) > limits.result)
        failed({ _tag: 'OverLimit', limit: 'result' })
      else finish({ _tag: 'Done', result: JSON.parse(message.text) })
    })
    worker.on('error', (error) =>
      failed(
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? { _tag: 'OverLimit', limit: 'memory' }
          : { _tag: 'Threw', message: said(error) },
      ),
    )
    worker.on('exit', () =>
      failed({
        _tag: 'Threw',
        message: 'The program ended without returning: it waited on something that never settles.',
      }),
    )
  }
  const receive = (message) => {
    if (message._tag === 'Start' && worker === undefined) start(message.code)
    else if (message._tag === 'Reply' && worker !== undefined)
      worker.postMessage({ id: message.id, value: message.value })
    // The server keeps its own reason for stopping; this only returns what was printed so far.
    else if (message._tag === 'Cancel') failed({ _tag: 'Unavailable' })
  }
  const taken = new Set()
  /** A file is a message once its line is complete; one still being written is left for the next event. */
  const drain = () => {
    if (finished) return
    for (const name of NodeFS.readdirSync(inbox)) {
      if (taken.has(name)) continue
      const text = NodeFS.readFileSync(NodePath.join(inbox, name), 'utf8')
      if (!text.endsWith('\n')) continue
      taken.add(name)
      receive(JSON.parse(text))
    }
  }
  NodeFS.mkdirSync(inbox, { recursive: true })
  // The first message may have arrived before this started, and its file made these directories
  // with the provider's own mode. Answers hold what the Person's accounts returned: owner only.
  NodeFS.chmodSync(directory, 0o700)
  NodeFS.chmodSync(inbox, 0o700)
  const watcher = NodeFS.watch(inbox, drain)
  const unstarted = setTimeout(() => failed({ _tag: 'Unavailable' }), START_SECONDS * 1000)
  // A message written before the watch began raises no event.
  drain()
}

if (NodeWorkerThreads.isMainThread) runner()
else program()

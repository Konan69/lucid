// The program runner. It is the only file of the server that runs on a Person's Computer, so it
// uses Node 24 and Linux Python 3 pidfds for descendant-exit receipts: the server sends this text as it is and starts it there with
// `node <this file> <result bytes> <log characters> <calls> <call bytes>`.
//
// The Computer is where a program runs (5 October 2026). There is no interpreter inside the
// interpreter and no second sandbox: the program is JavaScript in a worker thread of this process,
// with the Computer's files, network and Node modules, and as much of the Computer's memory as
// any other program on it. What it cannot do by itself is act for the Person: every tool call is
// printed for the server, which checks it as the Person and answers.
//
// The surface a program sees (`tools`, `accounts`, `text`, `console`, an async function body whose
// `return` is the result) is the one of pi's code mode, which this replaces
// (`@earendil-works/pi-codemode` 1.0.0, README "Usage" and `runtime/prelude-source.js`). The
// messages are the server's `protocol.ts`, one JSON value per line in both directions: going out
// on standard output (Call, Done, Failed), coming in on standard input (Start, Reply, Cancel).
// The server starts this over its SSH connection to the Computer, whose command channel carries
// both. Standard input closing means the server has gone, and ends the program.
//
// The rules switched off below are the server's rules for Effect code. None of them can be met
// here: this file has no Effect and no Schema to meet them with, because it must run on a
// Computer that has Node and nothing of Vivid's. `postMessage` is a worker thread's, which has no
// target origin.
/* oxlint-disable vivid/no-promise-constructor, vivid/no-try-catch, vivid/require-schema-decode-in-boundary, anti-slop/no-runtime-typeof, anti-slop-effect/no-manual-tagged-construction, anti-slop-effect/no-manual-tag-comparison, unicorn/require-post-message-target-origin */
import * as NodeChildProcess from 'node:child_process'
import * as NodeWorkerThreads from 'node:worker_threads'

/**
 * The program's side. It runs in a worker thread so that the thread above stays free to hear
 * Cancel while the program spins, and so that a program that runs out of memory ends itself and
 * not the runner, which still has to say so.
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
  const { limits } = NodeWorkerThreads.workerData
  let attempts = 0
  let limited = false
  /**
   * A limit ends the program here, before anything is forwarded, as the bridge of the interpreter
   * this replaces did. The server enforces the same limits, but it can only do so on what reaches
   * it: a program that starts calls without awaiting them would otherwise fill this process with
   * pending calls faster than the server reads them. The promise never settles, so a `catch`
   * around the call cannot carry the program past its limit.
   */
  const exceed = (limit) => {
    limited = true
    port.ref()
    port.postMessage({ type: 'over', limit })
    return new Promise(() => {})
  }
  /** Arguments make a JSON round trip, as in pi: what cannot be JSON rejects the call. */
  const call = (kind) => (input) => {
    const text = JSON.stringify(input)
    if (text === undefined) return Promise.reject(new TypeError('Tool input must be JSON.'))
    if (limited) return new Promise(() => {})
    if (++attempts > limits.calls) return exceed('calls')
    if (Buffer.byteLength(text) > limits.frame) return exceed('data')
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
  // The allowance is applied here, before a line is sent to the runner: what the runner would
  // drop is not sent at all, so a program that prints without end cannot fill the runner, whose
  // memory the program's heap limit does not cover. A line that passes the allowance is sent a
  // little over it and no further, and the runner cuts it on a whole character.
  let room = limits.logs
  const text = (value) => {
    if (room <= 0) {
      if (room === 0) port.postMessage({ type: 'cut' })
      room = -1
      return
    }
    const line = shown(value)
    port.postMessage({ type: 'log', text: line.length > room + 2 ? line.slice(0, room + 2) : line })
    room = Math.max(0, room - line.length - 1)
  }
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

/** Linux pidfds join captured descendants after killing them. A final result cannot race
 * an orphan that still writes a file, and a busy host cannot exhaust a polling allowance. */
function endChildren(then) {
  const command = String.raw`
import os, pathlib, select, signal
root = os.getppid()
parents = {}
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit(): continue
 try: stat = (entry/'stat').read_text()
 except FileNotFoundError: continue
 parents[int(entry.name)] = int(stat[stat.rfind(')')+2:].split()[1])
owned = [root]
for parent in owned:
 owned.extend(pid for pid, ancestor in parents.items() if ancestor == parent and pid != os.getpid())
descriptors = []
for pid in owned[1:]:
 try: descriptors.append(os.pidfd_open(pid))
 except ProcessLookupError: pass
for descriptor in descriptors:
 try: signal.pidfd_send_signal(descriptor, signal.SIGKILL)
 except ProcessLookupError: pass
while descriptors:
 ready, _, _ = select.select(descriptors, [], [])
 for descriptor in ready:
  os.close(descriptor); descriptors.remove(descriptor)
`
  NodeChildProcess.execFile('python3', ['-c', command], (failure) => {
    if (failure !== null) process.exit(1)
    else then()
  })
}

/** What the program printed, kept within its allowance of characters. */
function printedLines(allowance) {
  const logs = []
  let kept = 0
  let logsTruncated = false
  /**
   * Lines past the allowance are dropped here; the server fits what is kept to its exact bytes.
   * Every line costs at least one, so a flood of empty lines is cut like any other.
   */
  const keep = (line) => {
    if (logsTruncated) return
    if (kept + line.length + 1 <= allowance) {
      logs.push(line)
      kept += line.length + 1
      return
    }
    logsTruncated = true
    let prefix = ''
    // Whole code points only: half a surrogate pair is not text.
    for (const character of line) {
      if (kept + prefix.length + character.length + 1 > allowance) break
      prefix += character
    }
    logs.push(prefix)
  }
  /**
   * What the program writes straight to its output streams is printed text like any other. It is
   * also read so that the write ends: Node completes a worker's write only when this side takes
   * it (`lib/internal/worker/io.js`), so a program awaiting one would wait for ever unread.
   */
  const from = (stream) => {
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (text) => {
      const lines = (rest + text).split('\n')
      // The line still being written is held, but never past the allowance.
      rest = lines.pop().slice(0, allowance)
      for (const line of lines) keep(line)
    })
    stream.on('end', () => {
      if (rest !== '') keep(rest)
    })
  }
  /** The program printed more than is kept, and did not send the rest. */
  const cut = () => {
    logsTruncated = true
  }
  return { keep, from, cut, read: () => ({ logs, logsTruncated }) }
}

/** The runner's side: the messages in both directions, and the end of the program. */
function runner() {
  const [resultBytes, logCharacters, calls, frameBytes, kinds] = process.argv.slice(2)
  const limits = {
    result: Number(resultBytes),
    logs: Number(logCharacters),
    calls: Number(calls),
    frame: Number(frameBytes),
  }
  const output = printedLines(limits.logs)
  let worker
  let finished = false
  /**
   * Exactly one final message, printed when nothing of the program is left on the Computer: its
   * thread is over and the processes it started are ended. The server may start the next program
   * the moment it reads that line. The process itself ends only once the line is written out: an
   * exit straight after `write` can cut a long line short when the reader is slow.
   */
  const finish = (message) => {
    if (finished) return
    finished = true
    const ended = worker === undefined ? Promise.resolve() : worker.terminate()
    ended.then(() =>
      endChildren(() => {
        process.stdout.write(`${JSON.stringify({ ...message, ...output.read() })}\n`, () =>
          process.exit(0),
        )
      }),
    )
  }
  const failed = (failure) => finish({ _tag: 'Failed', failure })
  const start = (code) => {
    if (finished) return
    worker = new NodeWorkerThreads.Worker(new URL(import.meta.url), {
      workerData: {
        code,
        kinds: kinds.split(','),
        limits: { calls: limits.calls, frame: limits.frame, logs: limits.logs },
      },
      // What the program writes to its own output is not a message and must not become one.
      stdout: true,
      stderr: true,
    })
    output.from(worker.stdout)
    output.from(worker.stderr)
    worker.on('message', (message) => {
      if (finished) return
      if (message.type === 'log') output.keep(message.text)
      else if (message.type === 'cut') output.cut()
      // The input is already JSON text; it is placed in the line as it is, never parsed here.
      else if (message.type === 'call')
        process.stdout.write(
          `{"_tag":"Call","id":${message.id},"kind":"${message.kind}","input":${message.text}}\n`,
        )
      else if (message.type === 'over') failed({ _tag: 'OverLimit', limit: message.limit })
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
  // One message is one line. A piece of input may hold several lines, or the start of one.
  let unread = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (text) => {
    const lines = (unread + text).split('\n')
    unread = lines.pop()
    for (const line of lines) {
      // An order to stop ends the reading: a program is never started after it.
      if (finished) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // Not a message: the program ends the ordinary way, so what it started is ended and
        // what it printed is sent.
        failed({ _tag: 'Unavailable' })
        return
      }
      receive(message)
    }
  })
  // The server closed the connection or has gone: nobody is left to answer the program.
  process.stdin.on('end', () => failed({ _tag: 'Unavailable' }))
}

if (NodeWorkerThreads.isMainThread) runner()
else program()

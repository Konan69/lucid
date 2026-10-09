# Programs

A program is a short piece of restricted JavaScript that Vivid wrote and asked to run with
`run_code`. The server interprets it on a thread of its own. A program can compute over plain
data and call its four tools (`find_tools`, `use_tool`, `browse`, `read_page`); it can do nothing
else. The server keeps everything that needs trust: the Person's identity, the Integrations'
credentials, the Gate and the Approvals. The program holds none of them.

## How one program runs

1. `handlers.ts` takes the request as the acting Person in a Thread. `process.ts` admits it (one
   program per Thread, a bounded number at once, a source limit) and starts the clock.
2. `runner.ts` starts a thread (`worker.ts`) and hands it the text. The thread runs the
   interpreter (`interpreter/`), which parses the text with acorn and walks the syntax tree.
   There is no `eval` and no WebAssembly: a name the interpreter does not define does not exist,
   so a program has no files, network, modules, timers or `process`.
3. A tool call in the program is one message to the supervisor, in the same process
   (`protocol.ts`). `process.ts` counts it and `calls.ts` checks it as the Person, exactly as a
   call the model makes alone, and the answer is one message back. Calls a program starts
   together run together, at most eight at once.
4. The thread's final message carries the program's result and what it printed. An Approval, a
   blocking rule or an unknown outcome ends the program from the supervisor's side: no answer is
   sent and the thread is ended. Calls already running finish first.

Nothing the thread says is a receipt: the supervisor records what it dispatched and how each
call ended, and reports only that.

## Two layers, and why both

- **The interpreter is what a program cannot get out of.** It is a port of opencode's code mode.
  It gives a program its tools and plain data, and nothing of the host.
- **The thread is what a program cannot use up.** Its heap is capped, and the supervisor can end
  it. opencode runs its interpreter in its own process with only a time limit, which is right for
  one person on their own machine. Vivid's server is one process and one thread for every
  Person. Measured on 9 October 2026 with the interpreter in the server's own thread: a regular
  expression held the thread 1.9 seconds past a 1 second limit (and would hold it for minutes
  with a slightly longer input), and 21 small arrays grew the heap by 254 MB in one
  `JSON.stringify`. Both were inside every limit the interpreter can count, because a built-in
  runs on the host engine, where nothing can count or interrupt it.

## Limits

`budgets.ts` holds them. The supervisor enforces the deadline, the number of calls, the size of
each call and answer, the total data and the final result. The thread enforces the program's
heap. The interpreter enforces the program's work (`interpreter/work.ts`: steps taken, data made,
calls started, how deep its functions call each other), which ends an ordinary runaway program
early and with a message the model can act on, before the heap or the deadline has to.

## What a program cannot do

It cannot use the Person's Computer by itself. Vivid has file and shell tools on the Computer
(`docs/04-computer.md`, "Reaching the Computer"); a program is for the work between tool calls:
calling several tools, and filtering, joining and counting what they return.

## Tests

`process.test.ts` runs real programs through the production supervisor, thread and interpreter,
with only the check of each call replaced. `calls.test.ts` runs them with the real checks against a
disposable database. `interpreter/*.test.ts` are the interpreter's own, ported from opencode with
it. `thread.live.test.ts` runs a program from a real Thread and model and is off unless asked for.

## Where this came from

The interpreter is a port of opencode's code mode (`anomalyco/opencode`, `packages/codemode`,
commit 3884062, MIT), without its OpenAPI adapter and its tool catalog: Vivid's `find_tools` is
its discovery. Each file names the file it came from. Before 9 October 2026 a program was
ordinary JavaScript run in a Node worker on the Person's Computer, and every tool call crossed to
the server as a printed line and came back as a file; before 5 October it ran in pi's QuickJS
interpreter inside systemd, a cgroup and bubblewrap on the server.

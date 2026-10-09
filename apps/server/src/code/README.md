# Programs

A program is a short piece of restricted JavaScript that Vivid wrote and asked to run with
`run_code`. The server interprets it, in its own process. A program can compute over plain data
and call its four tools (`find_tools`, `use_tool`, `browse`, `read_page`); it can do nothing else.
The server keeps everything that needs trust: the Person's identity, the Integrations'
credentials, the Gate and the Approvals. The program holds none of them.

## How one program runs

1. `handlers.ts` takes the request as the acting Person in a Thread. `process.ts` admits it (one
   program per Thread, a bounded number at once, a source limit).
2. `process.ts` hands the text to the interpreter (`interpreter/`) with the four tools. The
   interpreter parses it with acorn and walks the syntax tree. There is no `eval`, no worker, no
   second process and no WebAssembly: a name the interpreter does not define does not exist, so a
   program has no files, network, modules, timers or `process`.
3. A tool call in the program is a function call in the server: `process.ts` counts it, and
   `calls.ts` checks it as the Person, exactly as a call the model makes alone. Calls a program
   starts together run together, at most eight at once.
4. The interpreter returns the program's result and what it printed. An Approval, a blocking rule
   or an unknown outcome ends the program from outside; calls already running finish first, and a
   `catch` in the program cannot see or stop its own end.

The receipts are the server's own: the program supplies none of what is reported about it.

## Limits

`budgets.ts` holds them. `process.ts` enforces the number of calls, the size of each call and
answer, the total data and the final result. The interpreter enforces the deadline and the
program's work: how many steps it takes and how much data it makes (`interpreter/work.ts`).

The work limit is Vivid's addition. opencode's interpreter bounds a program only by time, because
it runs for one person in their own process. Vivid's server is one process for every Person, and
the interpreter runs on its one thread: without the limit, one program that loops or keeps
appending to an array would take the server from everyone. Measured on 9 October 2026, such a
loop grew the heap by 155 MB in three seconds before the limit existed.

## What a program cannot do

It cannot use the Person's Computer by itself. Vivid has file and shell tools on the Computer
(`docs/04-computer.md`, "Reaching the Computer"); a program is for the work between tool calls:
calling several tools, and filtering, joining and counting what they return.

## Tests

`process.test.ts` runs real programs through the production supervisor and interpreter, with only
the check of each call replaced. `calls.test.ts` runs them with the real checks against a
disposable database. `interpreter/*.test.ts` are the interpreter's own, ported from opencode with
it. `thread.live.test.ts` runs a program from a real Thread and model and is off unless asked for.

## Where this came from

The interpreter is a port of opencode's code mode (`anomalyco/opencode`, `packages/codemode`,
commit 3884062, MIT), without its OpenAPI adapter and its tool catalog: Vivid's `find_tools` is
its discovery. Each file names the file it came from. Before 9 October 2026 a program was
ordinary JavaScript run in a Node worker on the Person's Computer, and every tool call crossed to
the server as a printed line and came back as a file; before 5 October it ran in pi's QuickJS
interpreter inside systemd, a cgroup and bubblewrap on the server.

# Programs

A program is JavaScript Vivid wrote and asked to run with `run_code`. It runs on the Person's
Computer. The server keeps everything that needs trust: the Person's identity, the Integrations'
credentials, the Gate and the Approvals. The program holds none of them.

## How one program runs

1. `handlers.ts` takes the request as the acting Person in a Thread. `process.ts` admits it (one
   program per Thread, a bounded number at once, a source limit) and starts the clock.
2. `computer.ts` wakes the Person's Computer and starts the runner on it (`guest.mjs`, sent as
   text and kept on the Computer under the hash of its content). The first program on a Computer
   installs the runner; later ones find it.
3. The runner runs the program in a worker thread. The program sees `tools`, `accounts`, `text`
   and `console`, and the Computer's own files, network and Node modules. It has as much of the
   Computer's memory as any other program there: the Computer is the Person's own machine.
4. The runner is one command on the server's SSH connection to the Computer
   (`computers/ssh/link.ts`, `converse`), and that command's channel carries both directions. A
   call the program makes for the Person is one line the runner prints; the server checks the
   call as the Person (`calls.ts`) and writes the answer as one line to the runner's input.
5. The program's final line carries its result and what it printed. An Approval, a blocking rule
   or an unknown outcome ends the program from the server's side; calls already running finish.

Nothing the program prints is believed: a line is decoded strictly, a call is admitted and
checked like any call the model makes alone, and the receipts are the server's own.

Until 10 October 2026 the answers were small files, written through the provider's API into a
directory the runner watched, because the provider could follow a command's output but not write
to it. The SSH channel made that directory, its removal and their bookkeeping unnecessary.

## Limits

`budgets.ts` holds them. The server enforces time (from waking the Computer to the last line),
the number of calls, the size of each call and answer, the total data, and the final result:
these protect the server and what the model has to read. The runner cuts printed output and
stops a program at the call and call-size limits before anything is forwarded, so a program that
starts calls without waiting for them cannot flood the server. Nothing limits what a program
does on the Computer itself. The Computer ends a runner that outlives its deadline.

## What is left on the Computer

Nothing of the program is left running when it ends by itself: the runner ends the processes
the program started and left attached to it, and only then prints its final line. A process the
program put in the background on purpose keeps running, as it does after a command. A program the
server gives up on (a decision, the deadline, a broken connection) has its command closed, and
the Computer then signals the runner and everything in its process group; a background process
meant to survive that must leave the group (`setsid`). What the program wrote on the Computer
stays: that is the Person's machine and the program's to use.

## Tests

`process.test.ts` and `calls.test.ts` run real programs with the real runner and the real start
command. Their Computer is the machine the tests run on (`testing.ts`): only the provider is
replaced. `computer.live.test.ts` runs the same thing on a real Boat machine and is off unless it
is asked for; it never creates a machine.

## Where this came from

What a program sees follows pi's code mode (`@earendil-works/pi-codemode` 1.0.0), which the
server ran inside systemd, a cgroup and bubblewrap until 5 October 2026. No container host
provides those, so production refused every program. The Computer is already a machine of the
Person's own, kept apart by its provider, so the program runs there with nothing added around it.
`signatures.ts` still uses pi's declaration renderer for the tool signatures the model reads.

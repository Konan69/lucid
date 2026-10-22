# Run a program

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

Vivid executes JavaScript on the Person’s Computer through run_code. Capture a successful program receipt and independently read a file written by that program. The fixed arithmetic scene belongs to rehearsal and is not a real-model recipe.

## How to get to it (user POV)

Ask Vivid to run an explicit program in a Thread with a disposable Computer. Specify an owned output file and expected contents, then independently read it back.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature code` after Launch and Doctor, then run `verify browser code`. Both commands currently return blocked before exercising the journey. Inspect `code/verdict.json` and `browser/code/verdict.json`; no action transcript, settlement, history or SQL is produced. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked here. The real Boat adapter is mounted, with no disposable Computer authority configured. Production Computers and cloudbox-vivid are outside this skill. A failed tool receipt is not proof of successful execution. Stored Thread replies and Feed posts also launch display Query programs after settlement and Mutation programs after a press. Those entry points remain unproved; see packages/client/state/src/display.ts and apps/server/src/code/source.ts.

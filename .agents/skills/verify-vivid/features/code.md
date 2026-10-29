# Run a program

Model requirement: needs a real model. Rehearsal is blocked: it cannot write a program.

## Sub-features

Vivid executes JavaScript on the Person’s Computer through run_code. Capture a successful program receipt and independently read a file written by that program. The fixed arithmetic scene belongs to rehearsal and is not a real-model recipe.

## How to get to it (user POV)

Ask Vivid to run an explicit program in a Thread. Specify an owned output file and expected contents, then independently read it back.

## Driving it with verify-vivid

Launch with VIVID_BOAT_API_KEY in VIVID_VERIFY_KEY_FILE; Doctor's `computer` field says `disposable` and whether Boat accepts a start now (`canStart`). Run `.agents/skills/verify-vivid/verify feature code` after Launch and Doctor, then `verify browser code`, each with the same VIVID_VERIFY_KEY_FILE. Each asks for one run_code program that writes a run-owned file holding a fresh UUID. The synthetic Person has no Computer, so the first program creates one through the product's own Boat path. The recipe then requires exactly one finished run_code part with `ok: true` and reads the file through Boat's files API, not through Vivid. The browser recipe sends through the composer and checks the reply bubble before and after reload.

Read `code/verdict.json`, `code/computer-file.json` (file name, expected and read text, machine id), the settlement, history and SQL rows, and `machines.json`. For the browser read `browser/code/` the same way plus its screenshots.

## Gotchas

- Each recipe needs the Computer to be created or started, which can take minutes on a first program. A Boat account that cannot start machines (`canStart: false` in Doctor) fails the recipe with the product's refusal; it is not verified.
- Cleanup deletes the machine; its receipt is `computer-cleanup.json`. A creation sent with no machine id recorded (a crash between Boat's answer and the binding write) is listed as unresolved and needs a hand check in the Boat account.
- Production Computers and cloudbox-vivid are outside this skill. A failed tool receipt is not proof of successful execution.
- Stored Thread replies and Feed posts also launch display Query programs after settlement and Mutation programs after a press. Those entry points remain unproved; see packages/client/state/src/display.ts and apps/server/src/code/source.ts.

# Notes

Model requirement: needs a real model with the shipped Notes tools. Rehearsal cannot prove this feature and both recipes block before creating a Thread in rehearsal mode.

## Sub-features

Vivid keeps a standing preference for the acting Person, answers from it, replaces the same note when corrected, answers from the correction, and deletes it when asked to forget. The recipe checks the actual `write_note` and `delete_note` receipts in each settled Run and that questions change nothing. A sentence saying that a preference was saved cannot satisfy an assertion.

The chosen Notes store is the Person cell's SQLite beside the native Pi Harness. Cell-backed
Notes integration and proof are in progress, not complete. The current launcher still uses the
old Node host and runtime PG migration command, so these recipes are blocked until it launches
cells. Notes belong to the acting Person, including in a shared Thread. They are separate from the product knowledge base and documents. `ListMemories`, document artifacts, and SQL fixtures cannot prove Notes behavior.

## How to get to it

Open a private Thread. Ask Vivid to remember a standing preference, correct it later, or forget it. The web exposes Notes through the composer and assistant replies. It has no dedicated Notes list or editor.

## Drive with verify-vivid

Use a fresh launch at the intended head and unchanged tree. Require Doctor to report `worthy: true`. Run these commands with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature notes pi-<id>
.agents/skills/verify-vivid/verify browser notes pi-<id>
.agents/skills/verify-vivid/verify cleanup pi-<id>
```

Both recipes use six real model turns asked in a Person's words, with no tool, file or field named (the owner, 26 October 2026). The create turn must write exactly one note whose body says "before noon", with `replaced: false`; its file is read from that receipt. The correction must write that same file with `replaced: true` and a body saying "after three": a second note fails. The forget turn must delete that same file. The three questions must change no note, and the first two replies must say the preference ("noon" and why, then "three"). Any extra write or delete fails the recipe.

The HTTP recipe uses the Person gateway, `WatchConversation` history, and `WatchThread` settlement. The browser recipe sends every prompt through **Message Vivid** and **Send**. It checks the actual Run's tool receipt, asserts the assistant reply in the rendered DOM, reloads, and checks that reply and durable history again after every turn. It does not claim that a Notes editor or list exists.

Inspect `notes/verdict.json` and `browser/notes/verdict.json`. Each recipe retains `steps.json`, `scope.json`, and a directory per operation with request or browser commands, settlement, public history, and `receipt.json`. Browser evidence also includes snapshots, screenshots, reply counts, and reloaded history. Only successful real runs can produce a proved verdict.

## Limits and prerequisites

These recipes were implemented for the pre-cell host and have not been proven on cells.
Cell-backed Launch and Doctor are required first. The earlier real-model attempts were also
blocked by OpenRouter HTTP 401 and insufficient Experiential Labs credits. A working shipped
model key and funded `EXPLABS_API_KEY` authority remain prerequisites. Then run Launch, Doctor,
both Notes recipes, and Cleanup on the same unchanged head. Formatting and syntax checks do not
establish runtime proof.

Owner cancellation, active-operation completion, idle hibernation, and retained Notes after an
owner move need the real cell host and native persistent storage. The former disposable
PG-adapter reopen test is not proof of these claims. Drive them through the cell-backed product
and retain the actual restart or move receipt. A browser reload proves neither lifecycle nor
process recovery. The current supervisor offers capture and cleanup, not owned cell restart or
move control; that missing integration blocks these claims.

Phone and desktop native clients need separate device runs. Cross-Person isolation, cross-Thread recall, index budgets, automatic preference selection, and concurrent edits are outside these recipes. No native dependency, app configuration, or binary changes belong to this verifier work.

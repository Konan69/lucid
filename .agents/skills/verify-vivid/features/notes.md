# Notes

Model requirement: needs a real model with the shipped Notes tools. Rehearsal cannot prove this feature and both recipes block before creating a Thread in rehearsal mode.

## Sub-features

Vivid keeps a standing preference for the acting Person, answers from it, replaces the same note when corrected, answers from the correction, and deletes it when asked to forget. The recipe checks the actual `write_note` and `delete_note` receipts in each settled Run and that questions change nothing. A sentence saying that a preference was saved cannot satisfy an assertion.

Notes belong to the runtime's Person-scoped SQLite store. They are separate from the product knowledge base and documents. `ListMemories`, document artifacts, and SQL fixtures cannot prove Notes behavior.

## How to get to it

Open a private Thread. Ask Vivid to remember a standing preference, correct it later, or forget it. The web exposes Notes through the composer and assistant replies. It has no dedicated Notes list or editor.

## Drive with verify-vivid

Use a fresh launch at the intended head and unchanged tree. Require Doctor to report `worthy: true`. Run these commands with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature notes flue-<id>
.agents/skills/verify-vivid/verify browser notes flue-<id>
.agents/skills/verify-vivid/verify cleanup flue-<id>
```

Both recipes use six real model turns asked in a Person's words, with no tool, file or field named (the owner, 26 October 2026). The create turn must write exactly one note whose body says "before noon", with `replaced: false`; its file is read from that receipt. The correction must write that same file with `replaced: true` and a body saying "after three": a second note fails. The forget turn must delete that same file. The three questions must change no note, and the first two replies must say the preference ("noon" and why, then "three"). Any extra write or delete fails the recipe.

The HTTP recipe uses the Person gateway, the public Flue SDK history, and `WatchThread` settlement. The browser recipe sends every prompt through **Message Vivid** and **Send**. It checks the actual Run's tool receipt, asserts the assistant reply in the rendered DOM, reloads, and checks that reply and durable history again after every turn. It does not claim that a Notes editor or list exists.

Inspect `notes/verdict.json` and `browser/notes/verdict.json`. Each recipe retains `steps.json`, `scope.json`, and a directory per operation with request or browser commands, settlement, public history, and `receipt.json`. Browser evidence also includes snapshots, screenshots, reply counts, and reloaded history. Only successful real runs can produce a proved verdict.

## Limits and prerequisites

These recipes are implemented but have not been run by their author. The parent reports live proof blocked by OpenRouter HTTP 401 and Experiential Labs insufficient credits. Supply a working key for a shipped real model and funded `EXPLABS_API_KEY` authority for the server's memory and title model. Then the parent must run Launch, Doctor, both Notes recipes, and Cleanup on the same unchanged head. Formatting and syntax checks do not establish runtime proof.

Owner cancellation, native operation draining, idle eviction, and capacity admission need the real SQLite checks in `packages/agent/runtime/src/notes.test.ts`. Pi process ownership and PostgreSQL restart recovery are checked in `packages/agent/runtime/src/routes.test.ts`. The browser launcher still targets Flue; its Pi migration is pending. The parent owns these checks and their red/green evidence. Their controlled scheduling and test provider do not establish real-model behavior. A browser reload cannot prove any of these lifecycle claims.

The current supervisor only supports capture and cleanup. Server process restart with retained stores is unsupported by this recipe. The Flue lifecycle test does not prove a supervisor or operating-system process restart. Add owned restart control before claiming that coverage.

Phone and desktop native clients need separate device runs. Cross-Person isolation, cross-Thread recall, index budgets, automatic preference selection, and concurrent edits are outside these recipes. No native dependency, app configuration, or binary changes belong to this verifier work.

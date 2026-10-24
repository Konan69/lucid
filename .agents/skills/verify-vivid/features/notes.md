# Notes

Model requirement: needs a real model with the shipped Notes tools. Rehearsal cannot prove this feature and both recipes block before creating a Thread in rehearsal mode.

## Sub-features

Vivid keeps a standing preference for the acting Person, reads its complete body, replaces the same file, reads the correction, deletes it, and receives the missing-note result on another read. The recipe checks the actual `write_note`, `read_note`, and `delete_note` receipts in each settled Run. A sentence saying that a preference was saved cannot satisfy an assertion.

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

Both recipes use a unique file and six real model turns. The prompts name the shipped tools and exact note fields so the proof can distinguish storage behavior from model paraphrasing. The create receipt must have `replaced: false`. The replacement must use the same file with `replaced: true`. Reads must return the exact original and replacement bodies. The delete must return the same file, and the final read must return the actual missing-note failure. Additional note mutations fail the recipe.

The HTTP recipe uses the Person gateway, the public Flue SDK history, and `WatchThread` settlement. The browser recipe sends every prompt through **Message Vivid** and **Send**. It checks the actual Run's tool receipt, asserts the assistant reply in the rendered DOM, reloads, and checks that reply and durable history again after every turn. It does not claim that a Notes editor or list exists.

Inspect `notes/verdict.json` and `browser/notes/verdict.json`. Each recipe retains `steps.json`, `scope.json`, and a directory per operation with request or browser commands, settlement, public history, and `receipt.json`. Browser evidence also includes snapshots, screenshots, reply counts, and reloaded history. Only successful real runs can produce a proved verdict.

## Limits and prerequisites

These recipes are implemented but have not been run by their author. The parent reports live proof blocked by OpenRouter HTTP 401 and Experiential Labs insufficient credits. Supply a working key for a shipped real model and funded `EXPLABS_API_KEY` authority for the server's memory and title model. Then the parent must run Launch, Doctor, both Notes recipes, and Cleanup on the same unchanged head. Formatting and syntax checks do not establish runtime proof.

Owner cancellation, native operation draining, idle eviction, and capacity admission need the real SQLite checks in `packages/agent/runtime/src/notes.test.ts`. Notes ownership across public Flue stop and start needs the disposable PostgreSQL lifecycle check in `packages/agent/runtime/src/keeping.test.ts`. The parent owns these checks and their red/green evidence. Their controlled scheduling and test provider do not establish real-model behavior. A browser reload cannot prove any of these lifecycle claims.

The current supervisor only supports capture and cleanup. Server process restart with retained stores is unsupported by this recipe. The Flue lifecycle test does not prove a supervisor or operating-system process restart. Add owned restart control before claiming that coverage.

Phone and desktop native clients need separate device runs. Cross-Person isolation, cross-Thread recall, index budgets, automatic preference selection, and concurrent edits are outside these recipes. No native dependency, app configuration, or binary changes belong to this verifier work.

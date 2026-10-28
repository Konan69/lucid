# Memory

Model requirement: needs a real model with the shipped Memory tools. Rehearsal cannot prove this feature and both recipes block before creating a Thread in rehearsal mode.

## Sub-features

Vivid keeps a standing preference for the acting Person, answers from it, replaces the same entry when corrected, answers from the correction, and retracts the local entry when asked to forget. The recipe checks the actual `write_memory` and `delete_memory` receipts in each settled Run and that questions change nothing. A sentence saying that a preference was saved cannot satisfy an assertion.

The chosen Memory store is the Person cell's native SQLite beside Pi. The launcher source now
uses celld, but real product proof remains pending. Memory belongs to the acting Person, including
in a shared Thread. They are separate from the product knowledge base and documents.
`ListMemories`, document artifacts and SQL fixtures cannot prove Memory behavior.

## How to get to it

Open a private Thread. Ask Vivid to remember a standing preference, correct it later, or forget it. The web exposes Memory through the composer and assistant replies. It has no dedicated Memory list or editor.

## Drive with verify-vivid

Use a fresh launch at the intended head and unchanged tree. Require Doctor to report `worthy: true`. Run these commands with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature memory pi-<id>
.agents/skills/verify-vivid/verify browser memory pi-<id>
.agents/skills/verify-vivid/verify cleanup pi-<id>
```

Both recipes use six real model turns asked in a Person's words, with no tool, file or field named (the owner, 26 October 2026). The create turn must write exactly one entry whose body says "before noon", with `replaced: false`; its file is read from that receipt. The correction must write that same file with `replaced: true` and a body saying "after three": a second entry fails. The forget turn must retract that same file in that same layer. Its receipt must report `forget_complete: false`; this is local retraction, not full forgetting across every layer or queued work. The three questions must change no entry, and the first two replies must say the preference ("noon" and why, then "three"). Any extra write or delete fails the recipe.

Each recipe chooses a unique project name for its meeting preference, so an earlier run or the other recipe cannot satisfy the create turn. Any tool error receipt fails the recipe, even if a later call succeeds.

The HTTP recipe uses the Person gateway, `WatchConversation` history, and `WatchThread` settlement. The browser recipe sends every prompt through **Message Vivid** and **Send**. It checks the actual Run's tool receipt, asserts the assistant reply in the rendered DOM, reloads, and checks that reply and durable history again after every turn. It does not claim that a Memory editor or list exists.

Inspect `memory/verdict.json` and `browser/memory/verdict.json`. Each recipe retains `steps.json`, `scope.json`, and a directory per operation with request or browser commands, settlement, public history, and `receipt.json`. Browser evidence also includes snapshots, screenshots, reply counts, and reloaded history. Only successful real runs can produce a proved verdict.

## Limits and prerequisites

These recipes now check the native local-retraction receipt and have not been proven on cells.
Cell-backed Launch and Doctor are required first. The earlier real-model attempts were also
blocked by OpenRouter HTTP 401 and insufficient Experiential Labs credits. A working shipped
model key and funded `EXPLABS_API_KEY` authority remain prerequisites. Then run Launch, Doctor,
both Memory recipes, and Cleanup on the same unchanged head. Formatting and syntax checks do not
establish runtime proof.

Owner cancellation, active-operation completion, idle hibernation, and retained Memory after an
owner move need the real cell host and native persistent storage. The former disposable
PG-adapter reopen test is not proof of these claims. Drive them through the cell-backed product
and retain the actual restart or move receipt. A browser reload proves neither lifecycle nor
process recovery. Use the supervisor's
[native cell controls](../references/cells.md) and retain native before/after ownership and
process receipts. Neither a control receipt nor a successful bundle proves Memory survived.

Phone and desktop native clients need separate device runs. Cross-Person isolation, cross-Thread recall, index budgets, automatic preference selection, and concurrent edits are outside these recipes. No native dependency, app configuration, or binary changes belong to this verifier work.

The forgetting step follows the shipped forget-something skill. It waits for the confirmation question, chooses the affirmative option for the fixture entry through AnswerInput or the visible web card, and checks the resulting Decision Run before asserting delete_memory. A pending confirmation is not a deletion failure.

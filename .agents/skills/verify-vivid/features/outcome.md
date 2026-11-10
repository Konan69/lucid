# Action receipts and Run outcomes

Model requirement: real model. Rehearsal cannot make the write.

Run `verify feature outcome <run>` and `verify browser outcome <run>` after Launch and worthy Doctor on the same unchanged head. Cleanup follows.

The recipe connects the disposable Verify Pulse Integration and creates a personal Allow rule through public RPC, so the write runs without a decision. It asks the real model to discover emit with find_tools and call it once with use_tool. The first completed Run must have no Approval, and a quiesced Executor export must hold exactly one matching provider event.

The journal must hold exactly one `vivid_actions` row for the Thread, named `call-<thread>-<tool call>`, linked to that Run, with no Approval and a `Completed` receipt. `ReconcileAction` on it answers `Applied` with that receipt and a `Settled` phase, and a second provider export still holds one event: reconciliation sends nothing.

Before acknowledgement the Run's outcome is `Completed`. HTTP sends `AcknowledgeRunDelivery` with the Run and its response, watches `WatchThread` until the outcome is `Delivered`, and sends it again. Browser presses nothing: the open Thread screen acknowledges the reply it drew, and the recipe waits on `WatchThread` for `Delivered`, then reloads. Both require a `Thread` receipt naming the signed-in Person and the same response, unchanged by the repeat. Finally removes the owned rule and Connection, including after failure.

## A background result delivered on the Feed

Background work reaches the Person on the Feed, so its Run is Delivered only when their Feed draws the card it posted; the post alone proves publication. In a second Thread the real model makes a Watch on Verify Pulse that posts each pulse to the Feed as a drawn card. The provider emits one pulse directly on the disposable Executor. WatchFeed waits for the card, which must be `Waiting` and not seen and name the background Run as `postedBy`. WatchThread waits for that Run to complete, and its outcome must be `Completed`: nothing has drawn the card yet.

HTTP then sends `MarkFeedCard` with `seen` for the card, the report web and phone send once the whole card is in view, waits on WatchThread for `Delivered`, and sends it again. Browser presses nothing: it stays on a Thread screen while the card is posted, opens `/feed`, and the Feed screen's own seen report delivers it; the recipe waits on WatchThread for `Delivered`, then reloads. Both require a `Feed` receipt naming the signed-in Person and the card, with the Run's own response, unchanged by the repeat or the reload.

Evidence stays in `outcome/feed/` and `browser/outcome/feed/`: the Watch request, the provider receipt, the delivered Feed, the away settlement (`away.json`), the seen reports and `proof.json`. Browser also retains `feed-delivered` and `feed-reloaded` captures.

## Evidence

Evidence stays in `outcome/` and `browser/outcome/`: settlement, journal rows, reconciliation, acknowledgements, safe provider exports and the proof. Browser also retains commands, snapshots and screenshots.

blocked: an `Unknown` receipt, its refused exact retry and reconciliation to `NotApplied` need a provider that loses its answer after acting; Verify Pulse always answers. Those rules are proved by the database-backed `apps/server/src/actions/journal.test.ts`. Programs, approved actions, shared Threads, the phone's acknowledgements (Thread and Feed) and channel delivery receipts remain unproved here. A card drawn while its Run still works, then never drawn again after the Run completes, leaves that Run `Completed`; the database-backed `apps/server/src/feed/store.test.ts` proves the working case delivers nothing.

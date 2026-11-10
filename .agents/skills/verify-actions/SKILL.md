---
name: verify-actions
description: Formally verify Vivid's action protocol with TLA+ (TLC) - who may let an Integration act reach the provider (Gate, Jev review, rules, Executor approval pauses, Approvals, Input requests, expiry, withdrawal) and how often it lands (action journal, retries, restarts, reconciliation). Use when a change touches apps/server/src/approvals, actions/journal.ts, connections/asks.ts, tools.ts dispatch, reconcile.ts, executor.ts call or resume, or inputs/store.ts Integration questions; or for "model-check the approvals", "can this send twice", "can an expired approval still run".
---

# Verify actions

Two TLA+ models describe the promises Vivid makes before anything leaves for a Person's account. `node .agents/skills/verify-actions/check.mjs` checks them with the pinned TLC in about 12 seconds. It also runs in the gate's `policy` stage.

| Promise (invariant) | Harm when broken | Model |
| --- | --- | --- |
| A Never rule always wins: an act it covers never takes effect, unless it only reads and Executor did not ask approval for it (`NeverWins`). | Vivid does what the Person or Company forbade. | `authority.tla` |
| A destructive act, or one Executor asked approval for, takes effect only when Jev's review said run or the Person consented (`ConsequentialNeedsReviewOrPerson`). | An unreviewed destructive act runs with nobody's say-so. | `authority.tla` |
| Nothing the Person declined takes effect (`DeclinedNeverRuns`). | Vivid acts after "no". | `authority.tla` |
| Nothing is sent on an expired pause, and no Approval runs after its deadline (`ExpiredNeverSends`). | A stale yes from yesterday acts today. | `authority.tla` |
| A question the Person withdrew by writing in the Thread is never answered "accept" (`WithdrawnNeverAccepted`). | A form the Person walked away from is submitted. | `authority.tla` |
| Each Approval is decided once, however many devices press at once (`DecidedOnce`). | Allow on the phone overrides Decline on the laptop. | `authority.tla` |
| Reconciliation never records NotApplied for an operation that took effect (`NotAppliedIsTrue`). | A retry is unblocked and the act happens twice. | `journal.tla` |
| The act never lands twice unless the first landing was recorded before the second send (`NoBlindSecondSend`). | Two emails, two events, two payments. | `journal.tla` |

## When to run it

Run `node .agents/skills/verify-actions/check.mjs` after any change to a file in the coverage record below, and before you call such a change done. Then run `node .agents/skills/verify-actions/check.mjs drift` to list the commits since the sync commit that touched covered files.

The check prints one line per TLC run and ends with `verify-actions: N anchors present; models as expected.` It fails on two kinds of difference:

- **anchor**: a guard that a model depends on is no longer in the named function (`anchors.json`). The model may no longer describe the code. Read the changed function. Then update the model action that cites it, and update the snippet in `anchors.json`.
- **run**: TLC found a violation that no open finding explains, or an open finding stopped reproducing.

Anchors catch a guard that was removed or rewritten. They do not catch a step that was added or moved (for example, a new early `return allow(...)` above the Never check). For those changes, the `drift` listing and your own read of the diff against the model are the check.

## Reading a result

Read every TLC result with the `/statechart` skill. For a violation, it gives the shortest path as numbered steps. For a pass, it draws how the system moves. Give it the model in `models/`, its `.cfg` with the constants of the run that failed (the run's name says which), and for `journal.tla` the view module `views/journal.mjs`. Use a chart config with `MaxCrashes = 0` and only the broken invariant. With that config the bug path stays short.

### Real bug or modelling error

Every action in the models names the code it stands for in its comment. Replay the path one action at a time against those functions:

1. For each step, open the cited function. Check that the code can take that step from that state. For example, check that the `UPDATE ... WHERE status = 'pending'` really lets both devices through.
2. If every step is possible in the code, it is a real bug. Report it in Vivid's words (Person, Approval, Thread, Run, Integration), with the path. Do not weaken the invariant. Do not change product code unless you were asked to.
3. If a step is not possible in the code, the model is wrong. Fix the action so that it does what the code does, cite the code, and rerun.

One model step must be one atomic step in the code: one SQL statement or transaction, or one Executor request whose answer Vivid waits for. If the code splits a step into two, the model must split it too.

## Changing the protocol on purpose

1. Change the model action that cites the code you changed. If the change is a new step, add an action with its citation.
2. Update `anchors.json`: the snippets of each guard the model now relies on, whitespace-insensitive, inside the named top-level declaration.
3. Prove that the check can still fail. Break the guard you changed in the code, mirror the break in the model, and see the invariant fail. Then revert both.
4. Run the check until it passes. Then move `sync` in `anchors.json` to the commit at which you confirmed the models describe the code. Move it only after that confirmation.

When a fix closes an open finding, its run starts to pass and the check fails with "no longer reproduces". Change that run's `expect` in `check.mjs` to `{ holds: true }` and move the finding to "Closed".

## Open findings

**F1: a Calendar event insert that timed out can be reconciled NotApplied while it is still running.** Run: `journal, Calendar lookup, Executor keeps running after Vivid stops waiting`.

Path (from `/statechart`):

1. The Person allows an Approval to add a Calendar event. Its operation is claimed and sent.
2. Executor is slow. After 90 seconds `responseReader` gives up, and `runJournaled` settles the operation `Unknown`.
3. The Run calls the same tool again. `answerBefore` finds the unresolved operation and reconciles it.
4. `reconcile.ts look` lists the Calendar, finds no event yet, and the operation is not `Dispatching`, so it answers `Absent`. The operation is recorded `NotApplied`.
5. The first insert then completes at Executor, and the retry's insert also goes out. The Person gets two events.

This depends on a provider call that keeps running after Vivid stops waiting. Executor's own source was not read to confirm this. Even if Executor stopped, its own request to Google may already be in flight. The guard `!ActionPhase.guards.Dispatching(...)` covers only operations Vivid is still waiting on, not ones it stopped waiting on. A fix direction, not applied: accept `Absent` only when the operation settled `Unknown` longer ago than any request can still be running. Alternatively, record that Vivid stopped waiting on a timeout, and never treat absence as proof for such an operation. Gmail never proves absence, and other tools have no lookup, so this affects only `calendarApi.calendarEventsInsert`.

## Bounds and assumptions

- `authority.tla`: one Thread, one Integration and one act, proposed once, with every mix of effect label, applicable rules (Never, Ask, Allow), failed rule judgment and Background Thread. Jev's review is chosen freshly at each Gate check. The bounds are two devices and at most two Executor pauses per operation. Exposure `PersonalInShared` is not modelled; it asks, like an Ask rule. Dreamer Threads, `requireNotDeclined`, Approval invalidation (`stale.ts`), "Always allow", edited drafts and the abandoned-execution sweep are not modelled either. The model assumes Executor resolves each pause once.
- `journal.tla`: one act, with two Run calls and one Approval operation, one server restart, and Executor answers of applied, refused, paused or (after 90 s) unknown. It does not model authority; every send is assumed allowed. The model also assumes that the reconciliation lookup finds an act that took effect. Calendar lists the private property directly; Gmail's search lag is why it never proves absence.
- Neither model covers the Computer's Browser or Desktop actions, a display's Mutation press (`useDisplayTool` is not journaled and does not go through the Gate), runtime-side tool retries beyond reusing the call id, or SQL isolation anomalies. Each SQL statement is taken as atomic, as Postgres runs it.
- A pass covers these models within these bounds, nothing more.

## Coverage record

`anchors.json` is the record: each entry names a model action, a file, a top-level declaration, and the guard snippets the action relies on. Sync commit: the `sync` field in `anchors.json`.

Files: `apps/server/src/approvals/gate.ts` (`gateLayer`, `reviewable`), `apps/server/src/approvals/policy.ts` (`reviewOutcome`, `unwatchedOutcome`), `apps/server/src/approvals/store.ts` (`move`, `requireUnexpired`, `decide`, `expire`, `raise`, `runJournaled`, `recover`), `apps/server/src/connections/asks.ts` (`approve`, `resumeApproved`, `answer`, `record`), `apps/server/src/connections/executor.ts` (`makeResume`, `responseReader`), `apps/server/src/connections/tools.ts` (`useToolAs`, `sendJournaled`, `resolveApproval`, `connectionRunner`), `apps/server/src/connections/reconcile.ts` (`look`), `apps/server/src/actions/journal.ts` (`unresolved`, `answerFor`, `claim`, `settle`, `release`, `reconcile`, `afterReconciliation`), `apps/server/src/inputs/store.ts` (`answerIntegration`, `withdrawWaiting`, `cancelWithdrawn`, `expireIntegrationInputs`).

## Tooling

TLC is `tla2tools.jar` 1.7.4, the newest release not marked pre-release. `check.mjs` downloads it once into `~/.cache/vivid-formal/` and verifies its SHA-256 on every run. TLC needs Java 11 or later; `check.mjs` looks in `JAVA_HOME`, then `PATH`, then `/usr/lib/jvm`. The check proves it can fail with seven scratch breaks, one per guard. Each break was made in the real code and mirrored in the model, and each was caught: the pending condition in `move` (`DecidedOnce`), auto-accepting an `Unreviewed` basis in `approve` (`ConsequentialNeedsReviewOrPerson`), the expiry check in `makeResume` (`ExpiredNeverSends`), an Allow rule ahead of Never in `Gate.check` (`NeverWins`), the `waiting` condition of the `answerIntegration` claim (`WithdrawnNeverAccepted`), the `Dispatching` guard in `look` (`NotAppliedIsTrue`), and the unresolved check in `answerFor` (`NoBlindSecondSend`).

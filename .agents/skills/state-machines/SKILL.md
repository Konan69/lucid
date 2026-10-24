---
name: state-machines
description: "Write or convert a client lifecycle as an Effect Machine (@typeonce/effect-machine) in packages/client/state, shared by web, phone and desktop. Use for 'make this a machine', 'state machine', 'effect machine', 'statechart', a useState status union or busy/error pair, state set after an await (vivid/react-no-state-after-wait), a double submit, a late answer overwriting a newer press, or reviewing a machine diff."
---

# State machines

A lifecycle moves through named steps and waits between them. In Vivid it is an Effect Machine in `packages/client/state`, read by every surface through atoms. Follow "Lifecycles are machines" in `AGENTS.md`. Read `docs/statecharts.md` for the decision and current runtime semantics. Its original measurements used 0.40.0. The [0.46.0 stress results](references/stress.md) distinguish reproduced behavior from unverified claims. The pattern files are `packages/client/state/src/connecting.ts` for surface services and `packages/client/state/src/feed.ts` for card identity and idempotency. Their effect outcomes now reject mismatched identities. Connecting also checks arrival identity. Keep those checks when reusing the pattern.

Check the installed version with `rg effect-machine pnpm-workspace.yaml`. This skill targets **0.46.0** on Effect 4.0.2. Read [references/library.md](references/library.md) for the runtime contract, lint rules, and confirmed mailbox race. Use [references/capabilities.md](references/capabilities.md) for general good-for and not-good-for guidance, separate Vivid usage, and the complete public export and option index.

## 1. Find and classify

Always run both the lint and `find.sh`. `pnpm gate --only lint --host <devbox-pick host>` reports `react-no-state-after-wait` against its ceiling in `scripts/gate/ratchets.mjs`. A plain `setX` after an `await` is counted there. `find.sh` lists only shapes the lint rule misses:

```bash
.agents/skills/state-machines/scripts/find.sh [paths]
```

For each candidate, trace the whole attempt before touching syntax: the press, what it waits on, every write after the wait, who reads the result, what cancels it, and its identity (which row, which Run, which card). Then classify it, from `AGENTS.md`:

- **Lifecycle**: named steps with waits between them. A machine.
- **Live query**: a value that only mirrors the server. It belongs in `packages/client/state/src/live.ts`, not a machine.
- **Plain state**: one yes or no that nothing waits on (a sheet open, text in a field, a selected option). Stays `useState`.
- **Server lifecycle**: stays in the database behind guarded writes, an idempotency key or a Run. A client machine never replaces it; it may front it.

Dismissal sends `Dismissed` with the attempt id. Leaving the working state interrupts its invoke. A write the server already accepted is not undone. Nothing a finished attempt reports may act on a dismissed screen, including a late `onClose`.

Many screens need two of these at once (a command machine plus a live query). Never copy server truth into machine state. Moving a setter into a reducer, a named callback, `Effect.sync` or a store silences the lint rule without fixing anything; read [references/finding.md](references/finding.md) for the shapes and the false conversions.

Completion: every candidate in scope has a class and a written trace.

## 2. Decide the owner and lifetime

Pick one, and write why in the module's JSDoc. A lifecycle read by more than one screen or entry point is session owned or keyed by entity. So is a lifecycle that must outlive its starting screen, such as sign-in away from the app or a send. A lifecycle confined to one dialog or sheet and ending on dismissal is React-subtree owned, with one machine per opening.

- **Session or page owned**: one module-level bridge mounted in the live registry (`connecting`). For a workflow the whole surface shares.
- **React subtree owned**: a factory used by one owner, keyed by the opening; dismissal ends it.
- **Keyed by entity**: `AtomMachine.family` (or one machine per key, like `feed`) when unrelated readers must find the same machine by an immutable key.

Read [references/wiring.md](references/wiring.md) for each recipe, registry identity, and how a machine is kept mounted and stopped.

## 3. Model it

Write the module `packages/client/state/src/<one-word>.ts` in this order: schemas, `Machine.state`, `Machine.events`, `Machine.make({ effects, streams, timers, branches })`, `.handle(...)`, then the projection the screens read. Rules (each is checked by review; most by the types):

- **States own their data.** A value that changes which events are taken or which work runs is a state; anything else is data on the lowest state that needs it. No `loading`/`error` flags beside each other.
- **Events are the domain protocol**: `Press`, `Submit`, `Cancel`, `Finished`, never `SetLoading`. Every press makes a new attempt id. The presser supplies it and the time (`attempt`, `at`). A transition reads no clock, makes no id, calls no service, awaits nothing.
- **Work belongs to the state that needs it** (`invoke` with `src` registered in `make`). Leaving the state interrupts it. Every reachable outcome has a transition: `onDone`, a typed `onFailure` that goes to a state the screen can word. Failures are `Schema.TaggedError`s that differ when handling differs.
- **An event a state does not name is not taken.** Use `guard` for one conditional edge, a named branch group with `select.*` for several outcomes, `declinable: true` plus `decline()` for a stale answer (compare the event's attempt id with the state's). `{ none: true }` *accepts* an event; it is not a refusal.
- **Identity travels with the attempt.** Anything said about an attempt from outside (a form answer, a dismissal) carries its attempt id and is declined if it is not the current one.
- **Attempt identity and idempotency differ.** An idempotency key may persist across retries of the same content. `feed.ts` reuses a failed delivery's key while each press gets a new attempt id.
- **Re-entered states check every invoke outcome.** For `reenter: true` or any path back into the same state, carry the attempt or revision through invoke input and output. Decline outcomes for another attempt. Typed failures and stream elements carry that identity too. Cancellation cannot remove an outcome already queued for the same state path and invoke id. The confirmed 0.46 race and evidence paths are in [references/library.md](references/library.md#reject-outcomes-from-another-attempt).
- **Timers are invokes**, registered in `make({ timers })` and owned by a state. A timer that guesses how long work takes is an arbitrary timeout; apply the `arbitrary-timeouts` skill (`~/.agents/skills/arbitrary-timeouts/SKILL.md`).
- `update` changes a state's data and keeps its running work; `reenter: true` restarts the work on purpose.
- What differs by surface is a `Context.Service` declared beside the machine and provided by each app. The machine imports nothing from React, the DOM or React Native. Apps do not depend on `@typeonce/effect-machine`; `@vivid/state` exports the domain API, not the library.

Read [references/library.md](references/library.md) for exact shapes, the compile-time guarantees and what the types still allow.

## 4. Wire each surface

- Adapter per app in `apps/<app>/src/data/<one-word>.ts`: it provides the services (RPC client, browser tab or `Linking`, navigator) and creates or mounts the bridge.
- A screen reads atoms (`AtomMachine.select`, `AtomMachine.can`, or a domain projection like connecting's `Standing`) and says its own words from **one exhaustive `.match`** over that projection. No `if`/`else` over state names.
- The machine ends in a state or emits an event that says what happened. Each screen reacts to that projection. Web may leave inline editing while phone closes its sheet. The machine never calls a screen callback to do this. Apply the dismissal rule from step 1.
- Send with `useAtomSet(machine.send)`. Disable controls from the machine's reading and let the machine refuse the event as well. The only flag outside the machine is a gesture reservation an adapter needs because the browser opens a tab only inside the click (`apps/web/src/data/connecting.ts` `press`); keep its reason beside it.
- The bridge queues sends during startup in write order. Send through `machine.send` without waiting for `ref`. An idle local send commits synchronous transitions and atom projections before returning. Entered invokes start in the sender's turn until their first suspension. Outcomes arrive in a later turn. Busy sends only queue. Never use `send` then `waitFor` as an acknowledgement.
- Hit every surface the lifecycle exists on: web, phone, desktop, and each entry point (Thread, Thread list, Settings, notifications).

## 5. Delete the old lifecycle

Remove every `useState`, flag, map and callback the machine replaced, on every surface. Measure the lint count again and write the exact new number as the `react-no-state-after-wait` ceiling in `scripts/gate/ratchets.mjs`; the gate rejects a ceiling above or below the measured count. Keep existing server guarantees (idempotency keys, attempt checks, proposal digests) intact.

## 6. Prove it

- No pure unit, property or sequence tests of state (`AGENTS.md`); the library's `MachineTest` planner traces are not used here. State invariants live in the machine and the types.
- Drive the real app with the `verify-vivid` skill (`.agents/skills/verify-vivid/SKILL.md`) for the feature the lifecycle serves, on the devbox. Exercise the races the trace in step 1 named: double press, press then cancel then press again, a slow answer arriving after a newer press, dismissal mid-flight, background and return on the phone. Check the phone on the devbox emulator. Name the feature file and the evidence path in the PR.
- Where the server is involved, a database-backed integration test with `VIVID_TEST_DATABASE_URL` proves the server side.
- `pnpm gate --host <devbox-pick host>` green, including the lowered ceiling.
- The seven `effect-machine` rules run at error for `packages/client/state`. Fix their diagnostics before review. [references/library.md](references/library.md#lint-in-the-gate) names all seven.

## 7. Review

Get a review from the other model family. Brief the reviewer on correctness per state and per event (what each state owns, which events it takes, what a late or stale event does), not on the diff alone, and hand it the checklist in [references/review.md](references/review.md).

## Report

The lifecycle and its class, the owner chosen, states and events in one line each, surfaces converted, the lint count before and after, verify-vivid evidence path, and the PR.

# Wiring a machine into Vivid's surfaces

Read from `origin/main` 2365c47f. Re-read the named files before copying; line numbers drift.

## The bridge

- `AtomMachine.make(machine)` makes a lazy bridge; with services, `AtomMachine.bind(Atom.runtime(layer)).make(machine)`. Every `make` is a new bridge, and each `AtomRegistry` runs its own instance of it. An extra `RegistryProvider` splits a machine readers expected to share.
- The bridge exposes `ref`, `snapshot` (runtime status, error snapshots read as success), `result` (logical state; runtime errors in the failure channel), writable `send` and `stop`, and `child(descriptor)`.
- `AtomMachine.can(event)` is declared once and applied to a bridge; it yields a boolean atom, `false` when done or stopped. The event may itself be an atom for a changing payload.
- `AtomMachine.select(machine, path)` reads a state's data as `Option`; `selectSnapshot` keeps child topology. Repeated calls return the same atom.
- `keepAlive` is an Effect Atom combinator, not a machine option. A bridge runs while something is mounted on it; the registry stops it after the last subscription and its idle retention (five minutes in `packages/client/state/src/live.ts` `makeLive`). `registry.dispose()` stops it at once.

## Owners in Vivid today

- **Connecting** (`packages/client/state/src/connecting.ts`, adapters `apps/web/src/data/connecting.ts`, `apps/mobile/src/data/connecting.ts`): one bridge per page (web) or per signed-in session (phone, `apps/mobile/src/data/live.ts` `makeLiveData`), made from `Layer.mergeAll(asking, signIn, keyForm, arrivals)`. A long-lived registry subscription keeps it mounted. On the phone, `stop()` ends emission listening and continuations before `engine.registry.dispose()`.
- **Feed** (`packages/client/state/src/feed.ts`, adapters `apps/web/src/data/feed.ts`, `apps/mobile/src/data/feed.ts`): one machine per card (`Idle`, `Sending`, `Sent`, `Unsent`). A newer post for the same card re-enters `Sending` with `reenter: true`; the same revision is declined. Retrying keeps the failed delivery's idempotency key; the presser makes the key (`crypto.randomUUID` on web, Expo `randomUUID` on phone). Adapters mount `machine.snapshot` and send through `ref.send` after `AtomRegistry.getResult(registry, machine.ref)`, so no send hits `NotReadyError`. No per-card pruning exists yet.

## A press, end to end (web connecting)

1. The screen calls the adapter's `press` with what was pressed and what to ask.
2. The adapter checks the machine's reading and its gesture reservation `unshown`, then reserves before any wait.
3. Inside the click, `window.open('about:blank')` holds a tab when sign-in is likely. The held tab is adapter authority, not machine state.
4. The adapter makes `attempt` (page-local counter, branded `AttemptId`) and `at` (`Date.now()`), and writes `ConnectingEvents.Press` into `machine.send`.
5. `Asking` invokes `ask`, which reads `Clock` with the answer; branches route to `Opening`, `Keying`, `Connected` or `Refused`.
6. Screens read `useAttempt()` and project with `standingOf` / `standingOfCard` into `Standing`, then word it with one exhaustive `Standing.match`.
7. A key form reports `Finished` with its own attempt id; a stale attempt is declined.

On the phone the shell owns foreground and navigation subscriptions; every return to the foreground sends `Returned`, and the machine decides whether it matters (`Opening` and `Away` both take it).

## Things that are easy to get wrong

- The comment at the top of `connecting.ts` names `canPress`; no such export exists. Screens use `waitingOn`, derived from `isWaiting` (`Asking`, `Opening`, `Checking`). Prefer `AtomMachine.can` for a new machine whose acceptance depends on a payload or guard.
- Emissions are not replayed. `connectedBy` (`AtomMachine.emissions`) must be subscribed with the same registry before the event happens. Upstream now advises against running required workflow steps from emissions; treat Vivid's `carryOn` on `Connected` as an existing choice, not the pattern for new required follow-ups (make those an invoke).
- `AtomRegistry.toStream` replays the current value first; keep that when a sign-in can finish before a listener attaches.
- Feed's `usePresses(select)` subscribes to the whole aggregate, not per selector; components that need narrow updates use path selectors.
- The key forms on both surfaces still keep their own busy and refusal state outside the machine. They are conversion candidates, not a pattern.
- After a rebase that changes `tsconfig.base.json` paths, `tsc-rs` can keep a stale result: delete `packages/agent/runtime/.cache/typescript/tests.tsbuildinfo`.

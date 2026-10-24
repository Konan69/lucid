# Wiring a machine into Vivid's surfaces

Read against main 579c6d63 and Effect Machine 0.46.0. Re-read the named files before copying.

## The bridge

- `AtomMachine.make(machine)` makes a lazy bridge; with services, `AtomMachine.bind(Atom.runtime(layer)).make(machine)`. Every `make` is a new bridge, and each `AtomRegistry` runs its own instance of it. An extra `RegistryProvider` splits a machine readers expected to share.
- The bridge exposes `ref`, `snapshot` (runtime status, error snapshots read as success), `result` (logical state; runtime errors in the failure channel), writable `send` and `stop`, and `child(descriptor)`.
- Write through `useAtomSet(machine.send)` or `registry.set(machine.send, event)`. Startup writes queue in order and fail with the startup error if startup fails. Writes after completion or stop fail with `StoppedError`. Adapters do not wait for `ref`.
- An idle local write commits synchronous transitions and atom projections before returning. Entered invokes run until their first suspension in the sender's turn. Their outcomes arrive in a later turn. A busy machine queues the write. A startup-queued write runs outside the original gesture.
- For a React-owned bridge, `createMachineContext` takes a factory with an options object containing `input`, `layer`, or both. The owner captures them once. Change the owner's React key to replace the machine.
- `AtomMachine.can(event)` is declared once and applied to a bridge; it yields a boolean atom, `false` when done or stopped. The event may itself be an atom for a changing payload.
- `AtomMachine.select(machine, path)` reads a state's data as `Option`; `selectSnapshot` keeps child topology. Repeated calls return the same atom.
- `keepAlive` is an Effect Atom combinator, not a machine option. A bridge runs while something is mounted on it; the registry stops it after the last subscription and its idle retention (five minutes in `packages/client/state/src/live.ts` `makeLive`). `registry.dispose()` stops it at once.

## Owners in Vivid today

- **Connecting** (`packages/client/state/src/connecting.ts`, adapters `apps/web/src/data/connecting.ts`, `apps/mobile/src/data/connecting.ts`): one bridge per page (web) or per signed-in session (phone, `apps/mobile/src/data/live.ts` `makeLiveData`), made from `Layer.mergeAll(asking, signIn, keyForm, arrivals)`. A long-lived registry subscription keeps it mounted. On the phone, `stop()` ends emission listening and continuations before `engine.registry.dispose()`.
- **Feed** (`packages/client/state/src/feed.ts`, adapters `apps/web/src/data/feed.ts`, `apps/mobile/src/data/feed.ts`): one machine per card (`Idle`, `Sending`, `Sent`, `Unsent`). A newer post re-enters `Sending` with `reenter: true`. The same revision is declined. Retrying keeps the failed delivery's idempotency key. The presser makes the key with `crypto.randomUUID` on web or Expo `randomUUID` on phone. Adapters mount `machine.snapshot` and call `registry.set(machine.send, feed.PressEvents.Press({ item, how }))`. No per-card pruning exists yet. The current invoke returns `void` and its failure carries only the card id. Neither outcome checks the revision. Apply [the attempt rule](library.md#reject-outcomes-from-another-attempt) before copying it.
- Phone connecting has no `unshown` reservation. Its next idle press reads the machine's updated waiting state. Its `owing().prune` needs only the current attempt. Web connecting keeps its gesture reservation for tab creation before the send.

## A press, end to end (web connecting)

1. The screen calls the adapter's `press` with what was pressed and what to ask.
2. The adapter checks the machine's reading and its gesture reservation `unshown`, then reserves before any wait.
3. Inside the click, `window.open('about:blank')` holds a tab when sign-in is likely. The provider address arrives after a network wait. Starting the invoke in the sender's turn cannot preserve activation across that wait. The held tab is adapter authority.
4. The adapter makes `attempt` (page-local counter, branded `AttemptId`) and `at` (`Date.now()`), and writes `ConnectingEvents.Press` into `machine.send`.
5. `Asking` invokes `ask`, which reads `Clock` with the answer; branches route to `Opening`, `Keying`, `Connected` or `Refused`.
6. Screens read `useAttempt()` and project with `standingOf` / `standingOfCard` into `Standing`, then word it with one exhaustive `Standing.match`.
7. A key form reports `Finished` with its own attempt id; a stale attempt is declined.

On the phone the shell owns foreground and navigation subscriptions; every return to the foreground sends `Returned`, and the machine decides whether it matters (`Opening` and `Away` both take it).

## Things that are easy to get wrong

- Screens use `waitingOn`, derived from `isWaiting` (`Asking`, `Opening`, `Checking`). Use `AtomMachine.can` when acceptance depends on a payload or guard.
- Emissions are not replayed. `connectedBy` (`AtomMachine.emissions`) must be subscribed with the same registry before the event happens. Upstream now advises against running required workflow steps from emissions; treat Vivid's `carryOn` on `Connected` as an existing choice, not the pattern for new required follow-ups (make those an invoke).
- `AtomRegistry.toStream` replays the current value first; keep that when a sign-in can finish before a listener attaches.
- Feed's `usePresses(select)` subscribes to the whole aggregate, not per selector; components that need narrow updates use path selectors.
- The key forms on both surfaces still keep their own busy and refusal state outside the machine. They are conversion candidates, not a pattern.
- After a rebase that changes `tsconfig.base.json` paths, `tsc-rs` can keep a stale result: delete `packages/agent/runtime/.cache/typescript/tests.tsbuildinfo`.

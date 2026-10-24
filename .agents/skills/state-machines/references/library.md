# Effect Machine 0.40.0: what the source says

Read from the installed package (find it with `ls node_modules/.pnpm | grep effect-machine`), whose source wins over any doc. The package ships its own guides in its docs folder: agent-guide.md, machine-review.md, effect-atom-react.md and root-api.md. Read them for anything below that is not enough. Where they recommend pure planner tests, Vivid's `AGENTS.md` overrides them.

## Declarations

- `Machine.state({ states })` declares topology and state-owned data. `fields` shorthand makes a tagged schema; a state with no data is `{}`. A node with `states` is compound unless `type: "parallel"`. Initial edges go in `.handle`, not here.
- State descriptors give `get(state, path)` and `matches`; an inactive path reads as `Option.none()`.
- `Machine.events({ Tag: fields })` (or `Machine.eventsFromSchemas`) is the public protocol. `Machine.internalEvents` are machine-local; `Machine.emittedEvents` are outward notifications.
- `Machine.make({ id, root, events, effects, streams, timers, branches, children, ... })`. There is no `guards` registry; guards are per transition.
- A registered effect or stream is either a lazy value (then the invoke has no `input`) or a function of exactly one argument (then the invoke must give `input`). Names are unique across `effects`, `streams` and `timers`.
- Chain `.handle({ initial, states })` from `make` and export its result.

## Transitions

- Direct: `{ target: "State", data: ({ state, event }) => ({ ... }) }`. `data` is schema make input; `{ decoded: true, data }` passes an already-decoded value.
- Keep data, keep work: `{ update: "State", data }`. Restart work on purpose: `reenter: true`. Targeting the current state without `reenter` changes nothing and keeps the running invoke with its original input.
- Several outcomes: a branch group in `make.branches`, then `{ branches: "group", resolve: (context, enqueue) => select.name({ data }) }`. When the resolver uses `TaggedUnion.match`, say its answer type: `type Next = ReturnType<(typeof select)[keyof typeof select]>` then `Union.match<Next>(...)`. Spreading a shared handler object into a branch loses the resolver's contextual types; write them inline.
- `guard(context)` refuses before construction. A resolver that can `decline()` needs `declinable: true`; declining discards its commands and lets an ancestor handle the event.
- `{ none: true }` handles the event with no transition. It means "accepted", not "refused".
- `enqueue.emit`, `enqueue.raise`, `enqueue.sendTo`, `enqueue.stop` collect work synchronously. `entry` and `exit` are synchronous too.
- Every callback must stay pure: the types constrain arguments and results, not side effects. No clock, randomness, ids, services or awaits.

## Invokes

- `invoke: { src, input, onDone, onFailure }` (or an array; give each a unique `id`). Effects need `onDone` when success is reachable (even `void`) and `onFailure` when a typed failure is reachable; a missing one is a compile error. Streams need `onElement`, `onFailure` when reachable, and always `onDone`.
- A stream element waits for its parent transition before the next element.
- Defects and interruption are not `onFailure`; an unhandled defect fails the machine.
- Cancellation stops the owned Effect. It does not undo an external side effect the server already accepted.

## Runtime order of one event

1. `send` queues the event (FIFO) and returns. Success means queued, not handled. An event no active state names is dropped without a transition.
2. The drain plans synchronously, picks the deepest active handler first, then ancestors.
3. Completion, `always` and raised events settle inside the same macrostep (capped at 1,000 iterations).
4. Invokes of exited states are stopped, then the new snapshot is published.
5. Emissions are delivered, then invokes of entered states start. A state exited during settlement never starts its invoke.
6. An invoke's outcome comes back as a private mailbox event and is discarded if its owner is no longer active.

So: **a state is published before its work starts.** A proof that answers "the call in flight" the moment it sees the state can answer before the call exists; hand answers through a `Queue`.

Unverified gap: a queued outcome carries the owner path and invoke id but no generation token. An outcome already queued behind a cancel and re-entry of the same state may be taken by the new attempt. Until a real run shows otherwise, keep the attempt id in state and decline outcomes for another attempt where it matters.

## Snapshots

`Machine.encodeSnapshot` / `decodeSnapshot` / `resume`. Resume restores logical state only: invokes, timers and children start fresh, so an in-flight submission runs again. Snapshots carry no machine id or migration version. Keep persistence out of a conversion unless the feature needs restart recovery and the server is idempotent for the replayed work.

## Not for Vivid client work

- `@typeonce/effect-machine/cluster` rejects machines with invokes. It is a persisted entity adapter.
- `MachineTest` (scenarios, invariants, explore, probe) exists; Vivid does not write those tests.
- VCOS (`~/work/VCOS`) pins 0.3.0: its domain modelling (blocked owns its reason, ids and time arrive as facts, explicit stale-settlement checks, finality in topology) carries over; its syntax (`defineStates`, `target.full`, `Machine.retag`, Effectful callbacks, component-driven I/O) is obsolete.

## Version drift

Vivid pins 0.40.0 (`pnpm-workspace.yaml` catalog). Upstream releases breaking changes in minors:

- 0.42: sends before startup are queued (0.40 fails them with `NotReadyError`); `Machine.start` needs a caller `Scope`.
- 0.44: `createMachineContext` takes `{ input, layer }`.
- 0.45: idle local sends commit synchronously; selectors update in the handler's turn. Not true on 0.40, so a controlled input driven by a machine needs a real run before you rely on it.
- 0.46: invoked work starts in the sender's turn until its first suspension. Not true on 0.40; the web popup reservation stays either way, because the tab opens after a network wait.
- Upstream ships `@typeonce/oxlint-plugin-effect-machine` (same version line) that catches duplicate invoke ids, async work and nondeterminism in callbacks, and redundant resolvers. Vivid does not have it yet; adopting it means moving the pin.

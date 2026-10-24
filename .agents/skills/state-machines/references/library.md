# Effect Machine 0.46.0

Find the installed package with `ls node_modules/.pnpm | rg effect-machine`. Read its agent-guide.md, machine-review.md, effect-atom-react.md, and root-api.md when the detail below is insufficient. Installed source wins over a guide. The published 0.46.0 package ships no CHANGELOG. Vivid's `AGENTS.md` overrides upstream advice to write pure planner tests.

## Declarations

- `Machine.state({ states })` declares topology and state-owned data. `fields` shorthand makes a tagged schema. A state with no data is `{}`. A node with `states` is compound unless `type: "parallel"`. Initial edges go in `.handle`.
- State descriptors give `get(state, path)` and `matches`. An inactive path reads as `Option.none()`.
- `Machine.events({ Tag: fields })` or `Machine.eventsFromSchemas` declares the public protocol. `Machine.internalEvents` are machine-local. `Machine.emittedEvents` are outward notifications.
- `Machine.make({ id, root, events, effects, streams, timers, branches, children, ... })` registers sources. Guards belong to transitions.
- A registered effect or stream is a lazy value with no invoke `input`, or a function of one argument with required invoke `input`. Names are unique across `effects`, `streams`, and `timers`.
- Chain `.handle({ initial, states })` from `make` and export its result.
- `Machine.start` requires a caller `Scope`. Closing it stops the machine and its owned work. `ref.stop` stops it earlier.

## Transitions

- Use `{ target: "State", data: ({ state, event }) => ({ ... }) }` for a direct transition. `data` is schema make input. `{ decoded: true, data }` passes an already-decoded value.
- `{ update: "State", data }` keeps running work. `reenter: true` restarts it. Targeting the current state without `reenter` preserves its work and original input.
- Declare conditional outcomes in `make.branches`. Use `{ branches: "group", resolve: ({ select }) => select.name({ data }) }`. When a resolver uses `TaggedUnion.match`, give its answer type with `type Next = ReturnType<(typeof select)[keyof typeof select]>` and `Union.match<Next>(...)`.
- Write handlers inline to preserve contextual types. Spreading a shared handler object into a branch loses resolver types.
- `guard(context)` refuses before construction. A resolver that calls `decline()` needs `declinable: true`. Declining discards its commands and lets an ancestor handle the event.
- `{ none: true }` accepts the event without a transition. Use `guard` or `decline()` when a control must be disabled.
- `enqueue.emit`, `enqueue.raise`, `enqueue.sendTo`, and `enqueue.stop` collect commands synchronously. `entry` and `exit` are synchronous too.
- Planning callbacks stay pure. Receive time, randomness, and ids as facts. Run services and asynchronous work through invokes. Types alone do not enforce purity.

## Invokes

- Use `invoke: { src, input, onDone, onFailure }`. Give each member of an invoke array a unique lifecycle `id`. Concurrent logic and children also need distinct runtime addresses.
- Effects require `onDone` when success is reachable, including `void`, and `onFailure` when typed failure is reachable. Streams require `onElement`, `onDone`, and `onFailure` when failure is reachable. Missing reachable handlers fail typecheck.
- A stream element waits for its parent transition before the next element.
- Defects and interruption do not enter `onFailure`. An unhandled defect fails the machine.
- Cancellation interrupts owned work. It cannot undo a side effect the server accepted or remove an outcome already queued.

## Runtime order

1. The atom bridge holds startup sends in write order. It delivers them once startup succeeds. Startup failure fails the held writes. Adapters send through the writable atom without waiting for `ref`. There is no `NotReadyError`.
2. An idle local send drains in the sender's turn. Synchronous transitions commit and atom projections update before it returns. A send received while the machine drains only queues.
3. The planner picks the deepest active handler, then ancestors. An event with no active handler makes no transition. Completion, `always`, and raised events settle in the same macrostep, capped at 1,000 iterations.
4. Exited invokes stop and the new snapshot publishes. Entered invokes run in the sender's turn until their first suspension. A state exited during settlement never starts its invoke.
5. Invoke outcomes enter the mailbox in a later turn, even when the work finishes without suspension. The entered state is observable before its outcome leaves it.
6. The invocation runtime checks ownership before queuing an outcome. The planner routes queued outcomes by active state path and invoke id. It does not compare invocation generations.

A browser call requiring user activation can run as the invoke's first step on a ready, idle machine. A startup-queued send runs after the gesture. A network wait also loses activation. Web connecting keeps its blank-tab reservation because the provider address arrives after that wait.

Do not treat `send` followed by `Machine.waitFor` as an acknowledgement. The snapshot may already match and does not identify the event that caused it. Keep required workflow steps in states. Use a typed receipt when an external observer needs to identify a completed attempt.

## Reject outcomes from another attempt

Any invoked state that can be re-entered must own an attempt or revision. This includes `reenter: true` and any transition path back into the same state. Carry the identity through invoke input and output. Compare it with the active state's identity in `onDone` and decline a mismatch. Typed failures and stream elements carry the identity and decline mismatches too. Capture the identity from that invocation's input. Reading the current state when constructing the outcome would label an old result as new.

This is a hard rule on 0.46.0. An outcome already queued for attempt 1 can complete the same state after attempt 2 re-enters it. Cancellation and the upstream ownership check do not prevent that ordering. `guard` or a `declinable: true` resolver can reject the mismatched outcome. A `none` branch accepts it.

The supplied evidence is /tmp/effect-machine-upgrade-evidence/reproduction.md and /tmp/effect-machine-upgrade-evidence/mailbox.json. The public-API probe is /tmp/effect-machine-046-mailbox.mjs. It holds the parent behind a parallel sibling's asynchronous finalizer, queues Cancel and Begin for attempt 2, then queues attempt 1's Done. Releasing the finalizer produces Finished with attempt 2 and value 1. The JSON records `staleOutcomeLanded: true`. The probe uses typed signals and no sleeps or patched internals. These local artifacts are not tracked in the repository.

The installed invocation.ts checks `isCurrent` before sending. The installed planner.ts uses `selectInvocationTransition` to match the active path and invoke id. invocationEvent.ts carries no generation. The probe confirms a library race. It does not demonstrate a failure in Vivid's existing single-region machines. Their unguarded invoke outcomes are not a pattern to copy.

## Lint in the gate

`.oxlintrc.json` enables `@typeonce/oxlint-plugin-effect-machine` 0.46.0 at error for TypeScript under `packages/client/state`. The lint stage runs all seven recommended rules:

- `effect-machine/no-async-planning-callback`.
- `effect-machine/no-browser-api-in-planning`.
- `effect-machine/no-conditional-none-branch`.
- `effect-machine/no-conflicting-invocation-identity`.
- `effect-machine/no-nondeterministic-planning`.
- `effect-machine/no-redundant-resolve`.
- `effect-machine/prefer-inline-handle`.

The rules inspect direct definitions in the same module. Review cross-module ownership and the attempt checks separately. A green lint run does not prove stale outcomes are rejected.

## Snapshots

`Machine.encodeSnapshot`, `decodeSnapshot`, and `resume` restore logical state. Invokes, timers, and children start fresh. An in-flight submission runs again. Snapshots carry no machine id or migration version. Add persistence only when the feature needs restart recovery and the server makes replayed work idempotent.

## Vivid exclusions

- `@typeonce/effect-machine/cluster` is a persisted entity adapter that rejects machines with invokes.
- `MachineTest` provides scenarios, invariants, exploration, and probes. Vivid proves behavior through database-backed integration tests or the real runtime.

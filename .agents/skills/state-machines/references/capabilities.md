# Effect Machine capabilities

READER: agent

This inventory covers `@typeonce/effect-machine`, `@typeonce/effect-machine-react`, and `@typeonce/oxlint-plugin-effect-machine` 0.46.0. Source citations use upstream commit `6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc`. The repository has package-scoped tags. The requested `v0.46.0` tag does not exist. The clone used `@typeonce/effect-machine@0.46.0`.

Descriptions report inspected source. Good-for and not-good-for lines are engineering judgments derived from that contract. Observed lines distinguish runtime results from source-only coverage. [stress.md](stress.md) gives commands, counts, and limits. [exports.md](exports.md) indexes every named public declaration, re-export, and namespace member with its source line, plus option schemas. It is the completeness backstop for less common type utilities.

Vivid usage is a separate dated record at main `ffe9e196e`. The scan was `git grep -n -E 'Machine\.|AtomMachine\.|effect-machine' origin/main -- packages/client apps .oxlintrc.json`, followed by reading every client module importing the library. Server modules named Machine are a different API. No-call findings refer to that inspected import set. They are not claims that a word is absent everywhere in the repository. Relative Vivid filenames below are under `packages/client/state/src` unless fully qualified.

## State declarations and accessors

`state({ schema | fields, states, type, output, annotations })` captures topology. Tagged schemas may stand alone. `get`, `getSnapshot`, and `matches` query paths. Inactive reads return `Option.none`. Schema-less nodes own control only. `type` is active, parallel, final, history, or choice. Schema-less annotations accept title, description, and documentation. Source [packages/effect-machine/src/Machine.ts:7997](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L7997).

Good for. State-owned values, nested workflows, and typed path traversal.

Not good for. A mirror of a remote database. Use a live query. Functions and services belong in the runtime layer, outside snapshot data.

Observed. State paths and fields were exercised by every stress script. The index links `State`, `StateAccessors`, and node config types.

Vivid usage. Used in `packages/client/state/src/connecting.ts:218`, `feed.ts:270`, and `deciding.ts:29`.

## Public, internal, and emitted protocols

`events(cases)`, `internalEvents(cases)`, and `emittedEvents(cases)` return schema-backed constructors. Each has an `*FromSchemas` form. Public and internal tags must be disjoint. Only public events are accepted at the independent input boundary. Source [packages/effect-machine/src/Machine.ts:8293](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L8293).

Good for. Public commands, private raised messages, and outward notifications with distinct contracts.

Not good for. Setter-shaped events or one protocol shared indiscriminately by callers and observers. Model domain requests and facts.

Observed. Public events were exercised by all probes. Protocol separation and FromSchemas runtime behaviour are source-only.

Vivid usage. Public events appear in `connecting.ts:251`, `feed.ts:281`, and `deciding.ts:36`. Emitted events appear in `connecting.ts:276`. No internalEvents call found.

## Definition construction and handle

`make({ id, root, events, internalEvents, emittedEvents, parent, input, effects, streams, timers, logic, children, branches }).handle(handlerTree)` produces an executable machine. Source names are unique across all five invoke-source registries. Handler keys are root, initial, states, on, always, invoke, entry, exit, onDone, output, history, and choice where topology permits. Source [packages/effect-machine/src/Machine.ts:8010](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L8010).

Good for. A definition that preserves inferred state, event, service, and error contracts.

Not good for. A speculative state framework around a boolean. Use plain state for values with no wait or lifecycle.

Observed. Every executable probe uses make and handle. Invalid schema-less data construction threw during probe development.

Vivid usage. Used in `connecting.ts:350`, `feed.ts:314`, and `deciding.ts:43`.

## Direct targets and decoded data

`{ target, data, decoded }` constructs a destination. `data` is schema make input. `decoded: true` accepts the schema Type and still validates it. Structural nodes reject data. Targeting a compound follows its initial declarations. Explicit subtree construction uses states. Source [packages/effect-machine/src/Machine.ts:6736](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6736).

Good for. A single unconditional destination with typed values.

Not good for. A dynamic destination encoded in a string or cast. Use named branches and bound selectors.

Observed. Targets were exercised throughout the suite. Transform schemas and invalid decoded values are source-only.

Vivid usage. Used in `feed.ts:334` and `deciding.ts:38`. No decoded flag found in current client machine definitions.

## Retained-owner update

`{ update: path, data, decoded }` replaces the complete value of the active source or a retained valued ancestor. It retains descendants and active invokes. Root is spelled `root`. Source [packages/effect-machine/src/Machine.ts:6815](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6815).

Good for. Editing data without restarting the work owned by that state.

Not good for. Changing work input and expecting the running invoke to restart. Use reentry. To change a sibling, send an event handled by that sibling.

Observed. `storm.mjs` updates counters without exit. `parallel.mjs` made two regions update one owner. The first region won in 100/100 trials.

Vivid usage. No update declaration found in current Vivid client machines. It could replace a self-target used solely to replace data.

## Combined target and owner update

`{ target, update, data }` constructs the destination and one retained owner atomically. Data returns target and update values. A named selector uses `update: { data }`. A choice destination receives the updated owner first. Its reachable branches must remain below that owner. Source [packages/effect-machine/src/Machine.ts:6784](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6784).

Good for. A child change and parent data change that form one decision.

Not good for. Two independent owners or an owner the destination exits. Reshape topology or send a separate domain event.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Root input and initialize

`input` declares a startup schema. Root construction and root initial callbacks receive decoded input. Nested initial callbacks receive state and ancestors. `{ initialize: input }`, or `initialize: true` without input, reconstructs the root and follows initial edges. `reenter` also restarts its lifecycle. Input is not a retained reset value. Source [packages/effect-machine/src/Machine.ts:6722](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6722).

Good for. Instance configuration and explicit reset with fresh input.

Not good for. Callbacks, router objects, or implicit credentials in snapshot data. Supply a Context service instead.

Observed. Child input was exercised by `races.mjs`. Root initialize and invalid input are source-only.

Vivid usage. No root input or initialize declaration found. Surface authority already uses services at `connecting.ts:816`.

## Reentry and self targets

`reenter: true` exits and enters the selected scope. Targeting the current state without reentry changes its value but retains work and original input. A later return through another state starts work anew. Source [packages/effect-machine/src/Machine.ts:6815](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6815).

Good for. Replacing an attempt when the old work must stop.

Not good for. Assuming interruption removes already queued outcomes. Include attempt identity in every outcome.

Observed. `races.mjs` ran 100 trials for every source, flag, and guard combination. Without reentry each effect or child started once. With reentry it started twice. Unguarded stale outcomes landed 100/100 per combination.

Vivid usage. Used for newer feed revisions in `feed.ts:363`. Its outcomes now check delivery identity at `feed.ts:344` and `feed.ts:352`.

## Named branches and select

`branches` declares named destinations. `{ branches: group, resolve(context, enqueue) }` chooses one bound `select.name(construction)`. The topology remains inspectable without executing the resolver. Data, decoded values, subtree states, and combined owner updates are construction arguments. Source [packages/effect-machine/src/Machine.ts:6872](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6872).

Good for. Several domain outcomes, commands attached to a selected edge, and inspectable conditional topology.

Not good for. One direct target with a resolver that only repeats construction. Use inline target and data.

Observed. Guarded stress trials used guard rather than select. Named branch execution is source-only in this suite.

Vivid usage. Used by `connecting.ts:416` and `feed.ts:320`.

## Guard

`guard(context)` refuses the edge before construction. Ancestor handling may still apply. Source [packages/effect-machine/src/Machine.ts:6925](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6925).

Good for. One conditional edge and concrete event acceptance for controls.

Not good for. An asynchronous permission query. Put the query in an invoke and represent its result as state.

Observed. `races.mjs` rejected 100/100 stale outcomes per guarded combination. Timer guard coverage uses a known first-attempt sentinel, not a timer-carried id.

Vivid usage. No guard property found in the three current Vivid machine definitions. They use decline resolvers.

## Declinable resolvers

`declinable: true` permits `decline()`. A decline discards commands and allows ancestor handling. Source [packages/effect-machine/src/Machine.ts:6925](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6925).

Good for. A resolver that must choose a branch or refuse an event based on its identity.

Not good for. Accepting a stale answer as a no-op. Use decline when acceptance itself must be false.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. Used for stale attempts in `connecting.ts:446` and deliveries in `feed.ts:343`.

## Accepted targetless transitions

`{ none: true }` accepts an event without a destination change. Its optional resolver returns undefined and may enqueue commands. `can` reports true for a selected none edge. Source [packages/effect-machine/src/Machine.ts:6966](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L6966).

Good for. A deliberately accepted notification or command with no state change.

Not good for. A conditional disabled control or stale-answer rejection. Use guard or decline.

Observed. Stream completion and command receipts used none edges in `races.mjs` and `children.mjs`. Acceptance projection is source-only.

Vivid usage. No none property found in the current Vivid machine definitions.

## Entry, exit, and always

Entry and exit callbacks are synchronous and return undefined. They can enqueue commands. Final states have no exit callback. Always transitions settle without an external event. Stabilization has a 1,000-microstep cap and fails with InfiniteTransitionError. Source [packages/effect-machine/src/Machine.ts:7291](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L7291).

Good for. Deterministic lifecycle bookkeeping and immediate topology decisions.

Not good for. Starting a Promise, calling a service, or using always as a retry loop. Put asynchronous work in an invoke.

Observed. The 1,000-step cap is source-only. Startup and exit lifetimes were exercised through invokes, not entry callbacks.

Vivid usage. No entry, exit, or always declaration found in the current machine definitions.

## Effect invokes

Register an Effect or a one-input function in effects. Invoke with `{ src, id?, input?, onDone, onFailure }`. A function source requires input. Reachable success and typed failure channels require handlers. Defects and interruption do not enter onFailure. Source [packages/effect-machine/src/Machine.ts:7122](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L7122).

Good for. A state-owned request, write, navigation action, or resource acquisition with typed failure.

Not good for. Detached fire-and-forget work or cancellation as a server rollback. Keep durable guarantees at the server.

Observed. `cancellation.mjs` observed 100 fetch aborts and 100 finalizers. `races.mjs` observed stale success and typed failure in all 100 unguarded trials per mode.

Vivid usage. Used in `connecting.ts:355`, `feed.ts:324`, and `deciding.ts:47`.

## Stream invokes

Register a Stream or a one-input function in streams. Invoke outcomes are onElement, onDone, and typed onFailure. Elements wait for the parent transition before the next element. Source [packages/effect-machine/src/Machine.ts:7087](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L7087).

Good for. A subscription whose useful lifetime is one state.

Not good for. A required workflow driven by an unowned React subscription. Invoke it. A live server value without a client lifecycle remains a live query.

Observed. `races.mjs` observed stale elements in 100/100 unguarded trials per mode. `resume.mjs` observed a new stream run after resume.

Vivid usage. Used by arrival in `connecting.ts:402` and its onElement edge at `connecting.ts:530`.

## Timer invokes

Timers register a Duration input or a one-input duration function. They are cancellable invokes whose onDone output is void. They restart at full duration on resume. Source [packages/effect-machine/src/internal/machine/invocation.ts:122](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/internal/machine/invocation.ts#L122).

Good for. A real expiry, debounce, retry policy, or domain deadline.

Not good for. Guessing request completion. A bare timer also cannot return its captured attempt id. Use an Effect that delays and returns the id for an attempt-sensitive timeout.

Observed. `timer.mjs` passed 100/100 full-duration resume checks. `races.mjs` delivered the old timer in 100/100 unguarded reentry trials. Its sentinel guard is a probe, not an application recipe.

Vivid usage. No timers registry found in current Vivid machines.

## Logic invokes

`logic({ initial, run })` hosts a custom process. Context exposes receive, state, setState, updateState, self, parent, spawn, sendTo, and stopChild. A registered logic invoke requires both lifecycle id and typed runtime address. onSnapshot observes its state. Source [packages/effect-machine/src/Machine.ts:9200](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L9200).

Good for. An existing process protocol or a custom actor with an explicit mailbox.

Not good for. Replacing a schema-first lifecycle with a manually maintained status union. Use Machine.state and handle.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Invoke arrays and identities

An invoke is one declaration or an array. Effects, streams, and timers default the lifecycle id to the source name. Logic requires id and address. A child descriptor fixes its id and rejects an invoke id override. Runtime-owned ids are scoped by state path. Caller addresses must be unique across simultaneously active processes. Source [packages/effect-machine/src/Machine.ts:7142](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L7142).

Good for. Independent work active in the same state.

Not good for. A sequence whose steps depend on each other or duplicate child addresses. Use sequential states or distinct descriptors.

Observed. `children.mjs` exercised an invoke array 100 times. `resume.mjs` used four source kinds in one array.

Vivid usage. No invoke arrays found in current Vivid machine definitions.

## Compound states

A compound state activates one direct child. Each compound handler declares initial. Child handlers run before ancestor handlers. Parent values are available as containingState and path-keyed ancestors. Source [packages/effect-machine/src/Machine.ts:3059](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L3059).

Good for. Shared data, cancellation, and event handling across mutually exclusive modes.

Not good for. A cartesian product of independent modes. Use parallel regions when all combinations are valid.

Observed. `races.mjs` used nested Work and Block compounds in 2,000 trials.

Vivid usage. Current Vivid machine roots are flat. No nested states declarations found inside their active states.

## Parallel states and completion

A parallel state activates every region. One event can transition independent regions. Completion waits for all regions. `onDone` handles completion, and an output callback can consume region outputs. Conflicting retained-owner updates are selected, not accumulated. Source [packages/effect-machine/src/Machine.ts:3086](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L3086).

Good for. Independent concurrent modes where every combination is valid.

Not good for. Several regions mutating one shared owner as though updates compose. Give the owner one handler.

Observed. `parallel.mjs` completed both regions in 100/100 trials. Competing +1 and +10 owner updates produced 1 in 100/100 trials. Reversed declaration order was not run.

Vivid usage. No parallel declaration found in current Vivid machine definitions.

## Final states and output

Final states end their region. A final or parallel node can declare an output schema and output callback. Final output context has state, containingState, ancestors, and event. It has no root property. Runtime join waits for final output. Source [packages/effect-machine/src/Machine.ts:5025](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L5025).

Good for. A bounded child workflow or an external observer awaiting completion.

Not good for. Closing an entire session machine when only one request completed. Use an ordinary settled state when more events remain valid.

Observed. `parallel.mjs`, `races.mjs`, and `children.mjs` exercised final output. An incorrect root access in probe development caused a defect and was removed.

Vivid usage. No final node or output declaration found in current Vivid machine definitions.

## History states

`{ type: history, history: shallow | deep }` restores its parent configuration. Shallow is the default. The handler history map supplies a first-use default that constructs a complete root configuration containing its owner. History is never active. Source [packages/effect-machine/src/Machine.ts:3120](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L3120).

Good for. Returning to the previous mode or nested configuration after a detour.

Not good for. Persisted crash recovery or resuming the same running request. Use encoded snapshots and an explicit replay policy.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Choice states

`{ type: choice }` has no value or active lifetime. Its required choice transition resolves immediately to a destination. It has no on, always, invoke, or completion handler. Source [packages/effect-machine/src/Machine.ts:3144](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L3144).

Good for. An inspectable transient routing decision shared by incoming edges.

Not good for. A loading screen, asynchronous decision, or place to store data. Use a real state with an invoke.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Parent protocol

`parent(events)` requires an owning machine. `optionalParent(events)` also permits a standalone root. The protocol controls the typed parent target available to handlers. Child compatibility is checked against owner events. Source [packages/effect-machine/src/Machine.ts:8317](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L8317).

Good for. Reusable children with explicit upward messages.

Not good for. Passing arbitrary callbacks through schema input or state. Use a typed protocol or Context service.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Raise, sendTo, stop, and emit commands

The synchronous enqueue object records raise, emit, sendTo, and stop. Raise settles in the current macrostep. SendTo targets a MachineTarget, child descriptor, or typed child address. Stop targets children. Runtime raise and emit are Effect capabilities. They are not top-level Machine.raise or Machine.emit exports. Source [packages/effect-machine/src/Machine.ts:575](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L575).

Good for. Internal causality, child messaging, and optional outward observations.

Not good for. Required navigation or writes driven by emissions. Invoke required work so failure and cancellation remain owned.

Observed. `children.mjs` exercised effectful child stop. Enqueue commands and emission replay are source-only.

Vivid usage. `enqueue.emit` is used in `connecting.ts:467`. No enqueue raise, sendTo, or stop call found there or in feed and deciding.

## Child descriptors, families, and spawn

`child(id, machine)` fixes an identity. `childFamily(machine)(id)` constructs keyed descriptors. `childAddress(id)` types logic addresses. Inside an invoke, `children.spawn(descriptor, { input })` starts a process-owned child. Top-level spawn, sendTo, and stopChild operate through Logic context. Spawned children survive the spawning state after startup succeeds. Source [packages/effect-machine/src/Machine.ts:9229](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L9229).

Good for. A state-owned child via invoke, or a runtime-sized group via spawn when the parent process owns lifetime.

Not good for. Replacing an existing child by reusing its active id. Stop it explicitly. Multi-child startup is not an automatic rollback transaction.

Observed. `children.mjs` observed 100 duplicate-id failures. Invoked children stopped on exit, dynamic children survived it, and all 200 child finalizers ran once.

Vivid usage. No child descriptors, child families, or spawn call found in Vivid client machines.

## Start, prepare, and stop

`start(machine, ...input)` requires Scope. `prepare(machine, ...input)` exposes changes, emissions, inspection, and a one-shot start Effect before initialization. The first evaluating Scope owns it. Closing Scope or running ref.stop stops the machine and owned work. Source [packages/effect-machine/src/Machine.ts:9424](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L9424).

Good for. Scoped execution, or subscription before initial-entry observations can occur.

Not good for. Creating unscoped application-global machines with no shutdown owner. Use an atom registry or explicit Scope.

Observed. All probes use Scope or registry ownership. Prepared inspection controlled all 2,000 race trials.

Vivid usage. Vivid starts through the atom bridge at `connecting.ts:816`, `feed.ts:398`, and `deciding.ts:78`. No direct start or prepare found.

## Runtime reference and observation

A ref exposes id, sessionId, state, snapshot, changes, emissions, join, stop, send, child, and childChanges. Runtime snapshots are active, done, stopped, or error. `watch(ref)` translates termination to detailed outcomes. Changes replay current state. Emissions do not replay. Source [packages/effect-machine/src/Machine.ts:2085](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L2085).

Good for. Rendering or observing a live lifecycle and waiting for bounded final output.

Not good for. Treating a stable definition id as a unique running instance. Use sessionId when runtime identity matters.

Observed. `children.mjs` queried child presence. `atoms.mjs` observed stopped snapshots. Emission non-replay is source-only.

Vivid usage. Vivid reads bridge snapshots rather than direct refs. `connectedBy` exposes emissions at `connecting.ts:824`.

## Send and waitFor

An idle local ref.send drains synchronous transitions before return. A busy send queues. Outcomes run in a later turn. `waitFor(ref, predicate)` accepts a matching current or later snapshot. Unmatched stop fails with StoppedError. Unmatched completion fails with NoSuchElementError. An unmatched error preserves its Cause. Source [packages/effect-machine/src/Machine.ts:9376](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L9376).

Good for. External observation of a particular logical condition.

Not good for. An acknowledgement that one send caused a condition. Use an attempt-specific receipt. An already matching state proves no causality.

Observed. `storm.mjs` checked final counters and FIFO. `races.mjs` waits for EventProcessed because EventSent precedes completed delivery.

Vivid usage. Adapters use writable send atoms. Direct waitFor is absent from the current client definitions.

## Snapshot encode, decode, and resume

`encodeSnapshot(machine, state)` and `decodeSnapshot(machine, unknown)` validate logical snapshots. `resume(machine, state)` starts from decoded state without initial constructors. Invokes restart. No running fiber or elapsed timer is persisted. Generic snapshots have no deployment identity or migration version. Source [packages/effect-machine/src/Machine.ts:8469](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L8469).

Good for. Explicit restart recovery with versioned storage and idempotent external work.

Not good for. Exactly-once requests or resuming a suspended fiber. Add server idempotency and replay policy.

Observed. `resume.mjs` observed 600 starts and 600 finalizers for effects, streams, and children across 100 start/resume pairs. Initial constructors ran 100 times. `timer.mjs` confirmed full timer restart.

Vivid usage. No snapshot persistence or resume call found in Vivid client machines.

## Can and enabled

`can(machine, snapshot, concreteEvent)` tests whether an edge is selected. `enabled(machine, snapshot)` synchronously returns structurally eligible event tags. It does not promise concrete acceptance. Only can returns an Effect. Both are planning queries. Guards and resolvers remain application code, so purity matters. Source [packages/effect-machine/src/Machine.ts:8872](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L8872).

Good for. Payload-sensitive acceptance via can and inspection of candidate transitions via enabled.

Not good for. Executing a permission query or service inside a planning callback. Invoke asynchronous work instead.

Observed. Dedicated projection and invalid-input probes unverified. Source contracts distinguish accepted none from refusal.

Vivid usage. Current screens derive waiting from domain projections, such as `deciding.ts:95`. No Machine.can or enabled call found.

## Planner and definition inspection

`planInitial`, `plan`, `configuration`, `stateNodes`, `initialDefinition`, `inputEventSchemas`, `transitionDefinitions`, and `activityDefinitions` expose pure planning and inspectable declarations. `isMachine`, `isFinal`, `InitialEvent`, `isInitialEvent`, InitialEventTypeId, and TypeId support adapters and introspection. Source [packages/effect-machine/src/Machine.ts:8670](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L8670).

Good for. Tooling, visualization, and library diagnostics.

Not good for. An application-side reducer beside the running machine. Use the runtime ref or atom selectors.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Atom make, bind, factory, and resume

`make(machine, ...input)` constructs a lazy bridge. `bind(Atom.runtime(layer))` provides external services and returns make, factory, family, and resume. `factory(machine)` preserves input arity and makes a new bridge on every call. `resume` makes a lazy resumed bridge. Each registry owns an independent runtime for the same bridge. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:1224](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L1224).

Good for. A stable UI owner, a shared service runtime, and deliberate registry isolation.

Not good for. Calling make on every render or adding a second registry to share an existing workflow. Keep owner identity stable.

Observed. `atoms.mjs` exercised make and bind. Factory and atom resume are source-only.

Vivid usage. Used in `connecting.ts:816`, `feed.ts:398`, and `deciding.ts:78`. No factory or atom resume call found.

## Atom bridge fields and writable commands

A bridge exposes ref, snapshot, result, send, stop, and child. Result puts runtime errors in AsyncResult failure. Snapshot retains an error runtime snapshot as a successful value. Send and stop queue through startup. Child commands can fail with ChildNotActiveError. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:81](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L81).

Good for. Declarative reads and event writes through one mounted registry.

Not good for. Waiting for ref before every user event, or recovering every failure as an empty value. Use typed AsyncResult handling.

Observed. `atoms.mjs` passed startup FIFO and startup failure in 100/100 trials each. Dispose and 1 ms idle expiry stopped invokes in 100/100 trials each.

Vivid usage. Adapters mount bridge snapshots. `deciding.ts:79` derives its reading from snapshot.

## Atom selectors and matches

`select(bridge, path)` returns AsyncResult of Option value. `selectSnapshot` keeps child topology. `matches` returns a boolean result. Each supports data-first and curried path forms. Repeated bridge/path lookup returns the same atom. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:499](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L499).

Good for. Narrow state-owned UI subscriptions.

Not good for. One subscription to an aggregate object when unrelated fields update often. Use a path selector or an equality-aware derived atom.

Observed. Path rendering was exercised by `react.mjs`. Repeated-lookup identity is source-only.

Vivid usage. Current Vivid code uses descriptor get and domain projections rather than AtomMachine.select. See `deciding.ts:83`.

## Atom can

`can(eventOrEventAtom)(bridge)` produces a cached acceptance projection. An event atom makes payload changes reactive. Done and stopped machines yield false. Startup, schema, and runtime failures stay typed. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:808](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L808).

Good for. A control enabled by the machine and its concrete payload.

Not good for. Running Effect.runSync in render or interpreting none as disabled. Use the projection and a refusing transition.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No AtomMachine.can call found. It could replace duplicated payload acceptance checks in future conversions.

## Atom family and lifetime

`family(machine, { atoms, label? })` exposes projections keyed by machine input. Keys use Effect Equal and Hash. Each public projection retains its private bridge owner. WeakRef and FinalizationRegistry support collection. The fallback uses Atom.family when those globals are absent. Registry mounts and idle retention determine runtime lifetime. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:1130](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L1130).

Good for. Unrelated consumers finding the same immutable entity-keyed workflow.

Not good for. Changing keys to update a running attempt or relying on garbage collection as cancellation. Send an event and choose a registry lifetime.

Observed. `atoms.mjs` collected 100/100 abandoned projection atoms after disposal. All 400 started invokes finalized once. GC without registry release was not asserted to stop anything.

Vivid usage. No AtomMachine.family call found. Feed currently makes one bridge per card at `feed.ts:398`; family could replace adapter-managed keyed lookup.

## Atom children and familyChild

`bridge.child(descriptor)` follows the active direct child. `familyChild(parent, { child: keyToDescriptor, atoms, label? })` builds keyed child projections. `selectChild`, `selectSnapshotChild`, and `matchesChild` preserve absence. `ChildOf`, ChildMachineAtom.Any, and MachineAtom.Any support generic readers. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:1175](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L1175).

Good for. A typed view of dynamic children without a second runtime or child lookup map.

Not good for. Observing a grandchild as though it were directly owned or inventing placeholder child state. Follow the owning bridge.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No call found in the pinned Vivid usage scan. No replacement is prescribed.

## Atom emissions and inspection

`emissions`, `inspection`, and `childEmissions` return streams using the current AtomRegistry service. `isMachineAtom` distinguishes root and child bridges. Emissions are ephemeral. Inspection follows the prepared machine from startup. Source [packages/effect-machine/src/unstable/reactivity/AtomMachine.ts:213](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/reactivity/AtomMachine.ts#L213).

Good for. Diagnostics and optional notifications observed in the same registry.

Not good for. Required workflow steps or replayable event history. Use invokes or durable storage.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. `connectedBy` uses AtomMachine.emissions at `connecting.ts:824`. No child emissions or inspection call found.

## React ownership and context

`useMachineAtom(create)` stores one bridge in React state and mounts ref after commit. `createMachineContext(factory)` returns Provider and useMachine. A factory takes no args or one options object containing input, layer, or both. Provider captures those options once. A new React key replaces the owner. Source [packages/effect-machine-react/src/MachineAtom.ts:24](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine-react/src/MachineAtom.ts#L24).

Good for. A dialog, route, or other committed subtree that owns one workflow.

Not good for. A session workflow that must outlive that subtree, or changing props as an implicit reset. Use a shared owner or explicit events.

Observed. `react.mjs` observed 200 factory evaluations, 100 actual starts, 100 stops, and at most one active invoke across 100 StrictMode owners. SSR observed zero starts.

Vivid usage. No effect-machine-react import found. Current Vivid owners are session or page adapters. Its future React-owned conversions should expose a domain wrapper from @vivid/state.

## MachineState and useMachineResult

`MachineState({ machine, path, pending?, inactive?, children })` renders a typed root or child snapshot. Pending and inactive default to null. It throws failures to an error boundary. `useMachineResult(atom)` returns AsyncResult without suspension and retains the last Success during Initial. Server reads use planned values. Source [packages/effect-machine-react/src/MachineAtom.ts:43](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine-react/src/MachineAtom.ts#L43).

Good for. State slots and hydration-aware readers.

Not good for. Assuming a test renderer proves DOM hydration, focus retention, or React Native behavior. Verify the real client.

Observed. `react.mjs` rendered state value 7 for 100 StrictMode owners. Separate server runs rendered `<b>7</b>` 100 times without starting work. Browser hydration was not run.

Vivid usage. No use of either export found in current Vivid code.

## MachineTest scenarios and planner traces

`scenarios`, `run`, `invariants`, `Invariant`, `checkInvariants`, `assertInvariants`, `verify`, `formatTrace`, `coverage`, and `observedGraph` generate planner traces and summaries. The export index includes their scenario, trace, coverage, law, and diagnostic types. Source [packages/effect-machine/src/testing/MachineTest.ts:264](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/testing/MachineTest.ts#L264).

Good for. Testing a statechart library or a project that permits pure planner tests.

Not good for. Proving fetch abortion, runtime cancellation, or Vivid product behavior with planner-only traces. Use runtime probes or database-backed and real-client checks.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No MachineTest import found. AGENTS.md forbids pure unit, property, and sequence tests of client state.

## MachineTest exploration and finite models

`explore`, `findShortest`, `assertReachable`, `assertUnreachable`, `verifyModel`, `finiteModels`, `compileModel`, and `interpretModel` explore bounded logical graphs or finite reference models. ModelVerificationError reports mismatches. Source [packages/effect-machine/src/testing/MachineTest.ts:1486](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/testing/MachineTest.ts#L1486).

Good for. Bounded graph exploration and independent library-model checks.

Not good for. Treating a finite graph as proof about arbitrary schemas, effects, or scheduling. Use runtime evidence for those claims.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No imports found. Vivid state behavior is verified through the runtime instead.

## MachineTest runtime and causal tools

`probe`, `runtimeInvariants`, `checkRuntimeInvariants`, `assertRuntimeInvariants`, and `assertPlannerRuntimeAgreement` observe runtime behavior. Re-exported command tools include runtimeCommands, sendCommand, stopCommand, advanceCommand, checkpointCommand, runRuntimeCommands, runEnqueuedCommands, runCausalCommands, verifyCausalCommands, and the three format*Transcript functions. Source [packages/effect-machine/src/testing/MachineTest.ts:523](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/testing/MachineTest.ts#L523).

Good for. Controlled clocks, explicit runtime synchronization, and scheduler differential tests.

Not good for. Sleep-based assertions or mocking the seam whose behavior is under test. Wait on observable receipts.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No MachineTest runtime helpers found. The throwaway stress suite uses the public runtime directly.

## Cluster persistence

`ClusterMachine.make(entityType, machine, { version }, ...input)` adapts planner state to persisted Cluster entities. Storage, makeMemory, layerMemory, CommitResult, SendResult, and RejectionReason are public. Checkpoints include machineId, version, requestId, and snapshot. Storage must atomically deduplicate requests and share the MessageStorage transaction for emission atomicity. Process-local invokes and spawn are rejected. Source [packages/effect-machine/src/unstable/cluster/ClusterMachine.ts:367](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/unstable/cluster/ClusterMachine.ts#L367).

Good for. A server-side persisted logical entity that fits Cluster ownership.

Not good for. A client lifecycle, durable background invokes, or exactly-once external side effects. Use a real server workflow and idempotency.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No effect-machine/cluster import found. Client machines do not replace server guarded writes.

## Devtools documents and walkthroughs

The separate effect-machine-devtools package exports DevToolsProtocol, MachineDocument, and MachineWalkthrough. Documents encode topology and activities. Walkthrough exports start, current, timeline, cursor, choices, take, and seek with typed unavailable-choice errors. CLI flags include root, include, host, port, open, watch-polling, and build out-dir. It requires Node >=22.19.0. Source [packages/devtools/src/index.ts:1](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/devtools/src/index.ts#L1).

Good for. Local graph inspection, documentation, and structural walkthroughs.

Not good for. A faithful live-provider simulation or a product dependency. Runtime targets and unavailable history have explicit limits.

Observed. Source inspected. Dedicated runtime probe unverified.

Vivid usage. No devtools package import or dependency found.

## Oxlint plugin

The default plugin exports seven rules and recommended. Recommended sets every rule to error. The rules are no-async-planning-callback, no-browser-api-in-planning, no-conditional-none-branch, no-conflicting-invocation-identity, no-nondeterministic-planning, no-redundant-resolve, and prefer-inline-handle. Rule schemas have no configurable options. Source [packages/oxlint-plugin/src/index.ts:11](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/oxlint-plugin/src/index.ts#L11).

Good for. Finding direct planning mistakes and static invocation-identity conflicts in the same module.

Not good for. Proving runtime ownership or stale-outcome safety from a green lint. Use identity checks and real runtime probes.

Observed. The requested policy, lint, and format gate is recorded in stress.md. No independent plugin fixture suite was run.

Vivid usage. All seven are error in `.oxlintrc.json:174`.

## Typed runtime errors

MachineSchemaDecodeError identifies input, event, emission, state, output, history, or configuration decoding failure. MachineSchemaEncodeError identifies snapshot encoding failure. InfiniteTransitionError carries maxIterations. StartupError carries a Cause. ChildAlreadyExistsError carries id. ProcessLocalError names an operation requiring a managed process. StoppedError reports use after stop or unmatched join. AtomMachine adds ChildNotActiveError. Source [packages/effect-machine/src/Machine.ts:356](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/Machine.ts#L356).

Good for. Handling distinct boundary and ownership failures without erasing their context.

Not good for. Catching every Cause as an expected refusal or logging invalid values. Keep defects distinct and keep secrets out of diagnostics.

Observed. Duplicate child failures were observed 100 times. Startup write failure propagation was observed 100 times. Other error variants are source-only.

Vivid usage. No direct library error handling found in the current client machine definitions. Domain invokes use their own TaggedError types.


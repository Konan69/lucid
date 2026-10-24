# Effect lifecycle and coordination capabilities

Effect 4.0.2. This is an installed-source reference. General fit guidance comes before repository applications. [The declaration catalog](inventory/index.md) preserves every selected export, overload, option, and public model member with source file and line. [Runtime evidence](evidence.md) records the scripts, output, and limits.

The catalog contains 1,598 distinct top-level exported names across 97 module pages. It includes complete coordination, Schedule, Duration, Stream, reactivity, workflow, and cluster modules. The Effect selection is explicit in the catalog index. Nested methods are present in declarations and excluded from the count. The additional discovery scan includes state-named exports outside those modules.

## Source and reproduction

Resolve `effect/package.json` from both `packages/client/state` and `apps/server` with `node -p "require.resolve('effect/package.json')"`. Both resolved the same `<repo>/node_modules/.pnpm/effect@4.0.2/node_modules/effect/package.json` in the investigation. The installed package exports `effect/reactivity`, `effect/workflow`, and `effect/cluster`. It has no `src/unstable` directory. Old imports from `effect/unstable` in the adjacent guidance are historical leads, not installed paths.

Run these commands from the repository root. Pass a checkout with installed dependencies as `<installed-repo>`. Run the probes on a development box. Their second argument is the resolved Effect package directory.

```bash
node .agents/skills/effect/scripts/inventory.mjs <installed-repo> .agents/skills/effect/rules/inventory origin/main
node .agents/skills/effect/scripts/probes/coordination.mjs <effect-package-directory>
node .agents/skills/effect/scripts/probes/lifetime.mjs <effect-package-directory>
node .agents/skills/effect/scripts/probes/time.mjs <effect-package-directory>
node .agents/skills/effect/scripts/probes/atoms.mjs <effect-package-directory>
node .agents/skills/effect/scripts/probes/presence.mjs <effect-package-directory>
```

The generator rejects any version other than 4.0.2. Its Git usage snapshot is immutable. Usage entries are lexical matches and may include comments, tests, or unrelated bindings. A missing qualified match leaves aliased use unverified. Re-run `git grep -n -w '<name>' <snapshot-sha> -- apps packages` and inspect imports before claiming an API is unused.

## Capability index

- [Child and scoped fibers](#child-and-scoped-fibers).
- [Fiber outcomes and interruption](#fiber-outcomes-and-interruption).
- [Interruption masks](#interruption-masks).
- [Finalizers and scoped acquisition](#finalizers-and-scoped-acquisition).
- [Scope](#scope).
- [Exit](#exit).
- [Cause](#cause).
- [Bounded parallelism and races](#bounded-parallelism-and-races).
- [FiberSet, FiberMap, and FiberHandle](#fiberset-fibermap-and-fiberhandle).
- [Deferred](#deferred).
- [Latch](#latch).
- [Semaphore](#semaphore).
- [PartitionedSemaphore](#partitionedsemaphore).
- [Queue and its variants](#queue-and-its-variants).
- [PubSub](#pubsub).
- [SubscriptionRef](#subscriptionref).
- [Ref](#ref).
- [SynchronizedRef](#synchronizedref).
- [RcRef](#rcref).
- [RcMap](#rcmap).
- [ScopedRef](#scopedref).
- [Pool](#pool).
- [Cache](#cache).
- [ScopedCache](#scopedcache).
- [Request and RequestResolver](#request-and-requestresolver).
- [Transactional state](#transactional-state).
- [Schedule](#schedule).
- [Effect retry and repeat](#effect-retry-and-repeat).
- [Timeout family](#timeout-family).
- [Clock, TestClock, and Duration](#clock-testclock-and-duration).
- [Stream callback and transport sources](#stream-callback-and-transport-sources).
- [Stream debounce, throttle, and grouping](#stream-debounce-throttle-and-grouping).
- [Stream interruption and graceful halt](#stream-interruption-and-graceful-halt).
- [Stream broadcast and share](#stream-broadcast-and-share).
- [Atom and AtomRegistry](#atom-and-atomregistry).
- [Atom keepAlive, idle TTL, and disposal](#atom-keepalive-idle-ttl-and-disposal).
- [Atom families](#atom-families).
- [Atom.fn and refresh](#atomfn-and-refresh).
- [Reactivity](#reactivity).
- [AtomRpc and AtomHttpApi](#atomrpc-and-atomhttpapi).
- [Workflow, Activity, and durable coordination](#workflow-activity-and-durable-coordination).
- [Cluster and SingleRunner](#cluster-and-singlerunner).
- [Machine, State, Mailbox, and unstable names](#machine-state-mailbox-and-unstable-names).
- [Single-result callback adaptation](#single-result-callback-adaptation).
- [Single-result memoization](#single-result-memoization).
- [TestClock](#testclock).
- [Duration](#duration).
- [AtomRef](#atomref).
- [AsyncResult](#asyncresult).
- [Hydration](#hydration).
- [Activity](#activity).
- [WorkflowEngine](#workflowengine).
- [DurableDeferred](#durabledeferred).
- [DurableClock](#durableclock).
- [DurableQueue](#durablequeue).

## Capabilities

### Child and scoped fibers

Forking starts an Effect in another fiber. forkChild attaches it to the parent. forkScoped uses the current Scope. forkIn uses a supplied Scope. forkDetach uses the global lifetime. Options include startImmediately and uninterruptible. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `forkChild`, `forkScoped`, `forkIn`, `forkDetach`, `awaitAllChildren`.

Good for: Background consumers, parallel attempts, and services whose work has an explicit owner.

Not good for: Persisted work owed after process death. Workflow and SQL-backed delivery belong to that problem. A detached fiber also needs an explicit shutdown policy.

Observed behavior and limits: Runtime-proved. lifetime.mjs prints scope.defaultCloseOrder ["child",2,1]. The child was started before its owner closed. Other fork options are source-verified only.

Vivid: Uses Effect.forkScoped in apps/server/src/channels/worker.ts:59. Candidate arrays of child fibers in apps/server/src/code/process.ts:371 need FiberSet or a stream consumer, while preserving admission and completion semantics.

### Fiber outcomes and interruption

Fiber.await returns Exit without propagating failure. Fiber.join propagates the fiber result. Fiber.interrupt requests interruption and waits for termination. Observer and unsafe operations are included on the Fiber interface. Source, signatures, and options are in [Fiber](inventory/lifetime/fiber.md). Related exports include `await`, `awaitAll`, `join`, `joinAll`, `interrupt`, `interruptAll`.

Good for: Joining work, observing completion, and ending owned background work.

Not good for: JavaScript CPU preemption or rollback of an accepted external write. Workers address CPU isolation. A provider receipt and idempotency address external writes.

Observed behavior and limits: Runtime-proved. lifetime.mjs prints interrupt-returned only after all the tested finalizers. FIFO in the coordination probes concerns wake registration, not eventual completion of arbitrary user work.

Vivid: Uses Fiber.join in apps/server/src/code/pool.ts:142. Candidate manual running array and join loop in apps/server/src/code/process.ts:371 and :391.

### Interruption masks

uninterruptible masks interruption. uninterruptibleMask supplies restore for the previous interruptibility. onInterrupt runs a cleanup Effect for interruption. abortSignal adapts fiber interruption to AbortSignal. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `interrupt`, `interruptible`, `uninterruptible`, `uninterruptibleMask`, `interruptibleMask`, `onInterrupt`, `abortSignal`.

Good for: Protecting acquisition and release while leaving the long wait interruptible. Adapter cancellation belongs beside callback registration.

Not good for: Masking an entire unbounded task. Restore interruption for its wait. AbortSignal cannot prove that an external write was undone.

Observed behavior and limits: Runtime-proved. lifetime.mjs prints uninterruptibleMask.restore ["acquisition-complete","finalizer","interruption-complete"]. The pending interruption is held until restore.

Vivid: Uses interruption-aware fibers in apps/server/src/code/pool.ts:128. Candidate AbortController plus delayed action in apps/mobile/src/screen/chat/Choices.tsx:180 belongs in a machine invoke with an interruptible timer.

### Finalizers and scoped acquisition

ensuring installs a finalizer. onExit passes Exit to the finalizer. acquireRelease registers release in Scope. acquireUseRelease brackets one use without exposing the resource lifetime. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `ensuring`, `onExit`, `onInterrupt`, `acquireRelease`, `acquireUseRelease`, `addFinalizer`, `scoped`, `scopedWith`.

Good for: Files, subscriptions, sockets, permits, and release obligations on success, failure, or interruption.

Not good for: Durable compensation across crashes. Workflow compensation still needs idempotent external operations and a durable engine.

Observed behavior and limits: Runtime-proved. lifetime.mjs prints ["onInterrupt","ensuring","resource-b","resource-a","onExit","interrupt-returned"]. This is the tested nesting and default sequential Scope. It does not imply an order for parallel finalizers.

Vivid: Uses Effect.acquireRelease in apps/server/src/code/pool.ts:94. Candidate explicit timer clear paths in apps/server/src/computers/ssh/link.ts:441 and :471 can move into one scoped adapter finalizer.

### Scope

Scope owns finalizers. Its constructors accept sequential or parallel finalizerStrategy. Closing records an Exit and executes registered finalizers. Source, signatures, and options are in [Scope](inventory/lifetime/scope.md). Related exports include `make`, `makeUnsafe`, `fork`, `addFinalizer`, `addFinalizerExit`, `close`, `provide`, `use`.

Good for: One lifetime that owns several resources and background fibers.

Not good for: Event state, transactions, or persistence. A machine models event transitions. SQL models durable authority.

Observed behavior and limits: Runtime-proved. lifetime.mjs prints scope.defaultCloseOrder ["child",2,1]. Source effect@4.0.2/src/internal/effect.ts:3975 reverses registration order for sequential close.

Vivid: Uses Effect scopes in apps/server/src/code/pool.ts:144. Candidate manual subscriber and timer cleanup in packages/client/state/src/stream.ts:70.

### Exit

Exit is the completed success or failure of an Effect. Its Failure carries Cause. Constructors, transformations, and matching operations are listed in the declarations. Source, signatures, and options are in [Exit](inventory/lifetime/exit.md). Related exports include `Exit`, `succeed`, `fail`, `failCause`, `isSuccess`, `isFailure`, `hasInterrupts`, `match`.

Good for: Completion receipts and outcome-dependent finalizers.

Not good for: An in-progress lifecycle. A machine state owns pending data. Exit records a completed attempt.

Observed behavior and limits: Runtime-proved through the timeout and queue probes. time.mjs prints Failure with TimeoutError for timeout and Success with None for timeoutOption.

Vivid: Uses Exit in packages/client/state/src/live.ts:8. No additional replacement established.

### Cause

Cause contains failure reasons. Reasons distinguish typed Fail, Die, and Interrupt. It also exposes Done for stream completion and TimeoutError. Source, signatures, and options are in [Cause](inventory/lifetime/cause.md). Related exports include `Cause`, `Reason`, `hasInterrupts`, `hasInterruptsOnly`, `findErrorOption`, `combine`, `pretty`.

Good for: Supervision and adapter code that must preserve interruption while classifying a failure.

Not good for: Flattening expected domain errors into strings. Tagged errors preserve the handling distinction. A Cause is not a domain state machine.

Observed behavior and limits: Runtime-proved. coordination.mjs reports interrupted queue takes. time.mjs reports externalInterrupted true for all three timeout operators.

Vivid: Uses Cause.findErrorOption in packages/client/state/src/live.ts:69. No additional replacement established.

### Bounded parallelism and races

all and forEach accept explicit concurrency options. Races distinguish first success from first completion. The exact overloads describe error and environment propagation. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `all`, `forEach`, `zip`, `zipWith`, `race`, `raceFirst`, `raceAll`, `raceAllFirst`.

Good for: Finite independent work, bounded provider fanout, and competing alternatives.

Not good for: Per-key shared lookup deduplication. Cache fits reusable results. RcMap fits scoped resources. A race is also not an external cancellation receipt.

Observed behavior and limits: Unverified at runtime. Read each race declaration before relying on failure or loser interruption.

Vivid: Uses Effect.forEach with concurrency in apps/server/src/code/process.ts:391. The adjacent manually retained fibers are a candidate for FiberSet, not an instruction to parallelize all admission work.

### FiberSet, FiberMap, and FiberHandle

FiberSet tracks scoped fibers. FiberMap tracks fibers by key. FiberHandle tracks one fiber. Their run and runtime adapters preserve an owning Scope. Source, signatures, and options are in [FiberSet](inventory/lifetime/fiberset.md). Related exports include `make`, `run`, `join`, `clear`.

Good for: Bounded ownership of many tasks, replacement by key, or one current background task.

Not good for: Result memoization or durable jobs. Cache and RcMap preserve different sharing contracts. SQL-backed work survives restart.

Observed behavior and limits: Unverified at runtime. Signatures and semantics for FiberMap and FiberHandle are in their separate catalog pages.

Vivid: Candidate running array in apps/server/src/code/process.ts:371. Its completion and failure behavior must be preserved before replacing it.

### Deferred

Deferred is a one-shot completion cell for a value or failure. Completion operations return whether they won. complete memoizes the supplied Effect result. completeWith stores the Effect directly. Source, signatures, and options are in [Deferred](inventory/coordination/deferred.md). Related exports include `make`, `await`, `succeed`, `fail`, `done`, `complete`, `completeWith`, `into`, `interrupt`, `poll`.

Good for: Readiness, one terminal receipt, and multiple waiters for the same result.

Not good for: Reusable gates or streams of events. Latch fits reopenable admission. Queue fits a sequence of one-consumer values. PubSub fits fanout.

Observed behavior and limits: Runtime-proved. coordination.mjs prints Deferred.wakeOrder [1,3] after cancelling waiter 2. Installed source Deferred.ts:1697 resumes the remaining registration array in order. Downstream scheduling can reorder completion.

Vivid: Uses Deferred in apps/server/src/code/pool.ts:48. Candidate callback receipt maps in apps/server/src/computers/signins/guest.ts:120 require an Effect-owned adapter before migration.

### Latch

Latch is a reusable gate. open admits current and future waiters. close blocks future waiters. release admits the current waiters while leaving the gate closed. Source, signatures, and options are in [Latch](inventory/coordination/latch.md). Related exports include `make`, `await`, `open`, `close`, `release`, `whenOpen`, `isOpen`.

Good for: Ready or paused gates with several reopen cycles.

Not good for: A value-bearing completion or a permit count. Deferred carries a one-shot result. Semaphore counts capacity.

Observed behavior and limits: Runtime-proved. coordination.mjs prints Latch.wakeOrder [1,3] and Latch.releaseKeepsClosed true. Installed source internal/effect.ts:5827 stores ordered waiter arrays.

Vivid: Candidate waiting callback set in apps/desktop/src/main/egress.ts:241. A Latch can coordinate callers but cannot create a WebSocket drain event.

### Semaphore

Semaphore counts permits. withPermit and withPermits acquire and release around work. withPermitsIfAvailable returns Option without waiting. take and release expose manual ownership. Source, signatures, and options are in [Semaphore](inventory/coordination/semaphore.md). Related exports include `make`, `withPermit`, `withPermits`, `withPermitsIfAvailable`, `take`, `takeIfAvailable`, `release`, `resize`, `releaseAll`.

Good for: Process-local locks and capacity bounds. One permit serializes an effectful critical section.

Not good for: Strict weighted FIFO, bounded admission queues, cross-process locks, or resource pools. Queue, Pool, and a durable database protocol address those shapes. releaseAll does not cancel current holders.

Observed behavior and limits: Runtime-proved. coordination.mjs prints equalPermitOrder [1,2,3] and mixedPermitOrder ["small","large"]. The two-permit waiter was overtaken by the later one-permit waiter.

Vivid: Uses Semaphore in apps/server/src/code/pool.ts:90. The custom FIFO admission queue at :47 is not a proven drop-in replacement. It also has a bounded waiting room and synchronous handoff.

### PartitionedSemaphore

PartitionedSemaphore limits concurrent work independently for each partition key. Its public model exposes the keyed permit wrappers. Source, signatures, and options are in [PartitionedSemaphore](inventory/coordination/partitionedsemaphore.md). Related exports include `make`.

Good for: Per-tenant or per-resource in-process serialization.

Not good for: Cross-process ownership and custom admission order. SQL claims provide durable authority. A bounded queue can provide an explicit waiting-room policy.

Observed behavior and limits: Unverified at runtime. Capacity reclamation and fairness need a focused proof before becoming lifecycle requirements.

Vivid: Candidate keyed permits in apps/server/src/computers/boat/lifecycle.ts:217. Import and implementation fit remain unverified.

### Queue and its variants

Queue hands each message to one taker. bounded suspends offers at capacity. dropping rejects excess new items. sliding evicts old items. unbounded grows without a capacity limit. Queue carries an error channel and Done completion. Source, signatures, and options are in [Queue](inventory/coordination/queue.md). Related exports include `make`, `bounded`, `dropping`, `sliding`, `unbounded`, `offer`, `offerAll`, `take`, `takeAll`, `takeN`, `takeBetween`, `poll`, `end`, `fail`, `failCause`, `shutdown`.

Good for: Work handoff, callback adaptation, backpressure, and bounded coalescing when loss is intentional.

Not good for: Broadcast or crash durability. PubSub gives each subscriber a copy. PersistedQueue stores owed work. A sliding queue loses older work by design.

Observed behavior and limits: Runtime-proved. coordination.mjs prints shutdown {"blockedOffer":false,"takeInterrupted":true,"size":0}. A pending empty take also interrupts. end drains "retained" before Done. Dropping and sliding eviction are source-verified only.

Vivid: Uses a sliding change queue in packages/client/state/src/snapshot.ts:187. Candidate manual buffered delivery must preserve the terminal protocol in apps/server/src/code/process.ts:373.

### PubSub

PubSub delivers messages to each current subscription. Bounded storage applies suspend, dropping, or sliding policies. Constructors accept replay for late subscribers. subscribe requires Scope. Source, signatures, and options are in [PubSub](inventory/coordination/pubsub.md). Related exports include `bounded`, `dropping`, `sliding`, `unbounded`, `subscribe`, `publish`, `publishAll`, `take`, `end`, `shutdown`.

Good for: Process-local fanout with an explicit retention and overflow policy.

Not good for: Durable cursor replay, database changefeeds, or one-consumer work dispatch. An event log or durable queue supplies different guarantees.

Observed behavior and limits: Runtime-proved. coordination.mjs prints lateReplay [2,3] for replay 2 after publishing 1,2,3 without subscribers. Default replay is 0. A bounded publisher waits until both current subscribers consume the occupied slot.

Vivid: Candidate callback fanout in packages/client/state/src/live.ts:331. Changing a synchronous session notification into an asynchronous stream needs a caller contract review.

### SubscriptionRef

SubscriptionRef stores a current value and publishes changes. Construction uses an unbounded PubSub with replay 1. Effectful modifications serialize through one semaphore. Source, signatures, and options are in [SubscriptionRef](inventory/coordination/subscriptionref.md). Related exports include `make`, `get`, `changes`, `set`, `modify`, `modifyEffect`, `update`, `updateEffect`.

Good for: Current in-memory status plus ordered subscriptions to updates.

Not good for: Durable history or a client event protocol. A database owns durable state. An Effect Machine owns lifecycle transitions. Ref fits a value without observers.

Observed behavior and limits: Runtime-proved. coordination.mjs prints changes [0,1,1,2]. The initial value is replayed and equal successive writes are emitted. Concurrent effectful update ordering is source-verified only.

Vivid: Uses live state through Atom in packages/client/state/src/live.ts:200. No proven SubscriptionRef replacement is established for that richer projection.

### Ref

Ref stores one mutable value with synchronous atomic modification operations in Effect. Source, signatures, and options are in [Ref](inventory/coordination/ref.md). Related exports include `make`, `get`, `set`, `modify`, `update`, `getAndUpdate`.

Good for: Counters, indexes, and a shared value whose transition is pure.

Not good for: Awaited read-modify-write sequences. SynchronizedRef.modifyEffect serializes an effectful update. TxRef and Effect.tx coordinate several transactional values.

Observed behavior and limits: Unverified at runtime. The generator preserves all Option-based and unsafe variants.

Vivid: Uses Ref in apps/server/src/computers/boat.test.ts:152. No production hand-rolled Ref replacement established.

### SynchronizedRef

SynchronizedRef stores a value behind a semaphore. Its effectful modifier holds serialization across suspension. Source, signatures, and options are in [SynchronizedRef](inventory/coordination/synchronizedref.md). Related exports include `make`, `get`, `set`, `modifyEffect`, `updateEffect`.

Good for: An in-memory state update that must await work before committing the new value.

Not good for: SQL transaction isolation, durable authority, or independent values that need one atomic commit. SQL and Effect.tx fit those distinct domains.

Observed behavior and limits: Unverified at runtime. Failure and interruption semantics require an integration proof when an external write participates.

Vivid: Candidate callback-held state in apps/server/src/computers/ssh/link.ts:427. A callback adapter still needs an explicit state model and cancellation receipt.

### RcRef

RcRef acquires one scoped resource lazily and counts borrowing scopes. idleTimeToLive can retain it after the last reference leaves. Source, signatures, and options are in [RcRef](inventory/coordination/rcref.md). Related exports include `make`, `get`, `invalidate`.

Good for: Shared connection or subscription ownership with release after the final borrower.

Not good for: A result cache or exclusive lease. Cache memoizes results. Semaphore limits access. RcRef shares a resource concurrently.

Observed behavior and limits: Unverified directly at runtime. RcMap idle release was proved separately. That result is not a substitute for an RcRef proof.

Vivid: Candidate shared stream lifetime in packages/client/state/src/live.ts:383. Its existing Atom ownership must be compared before introducing another owner.

### RcMap

RcMap lazily acquires scoped resources by key. Concurrent borrowers share the pending lookup or resource. capacity limits entries. idleTimeToLive can vary by key. Source, signatures, and options are in [RcMap](inventory/coordination/rcmap.md). Related exports include `make`, `get`, `getOption`, `invalidate`, `touch`, `keys`.

Good for: Keyed clients, sessions, subscriptions, and reference-counted in-flight executions.

Not good for: Blind caching of completed writes, LRU eviction promises, or strict admission fairness. Cache fits recomputable values. A queue owns admission policy.

Observed behavior and limits: Runtime-proved. time.mjs prints acquired 1, reused 1, released [["x",1199]]. The first reference ended at 1000. Reuse at 1099 moved release to 1199. No release occurred at either 99 ms checkpoint.

Vivid: Uses RcMap in apps/server/src/code/pool.ts:124. This already replaces in-flight sharing. Its custom waiting room at :47 has additional semantics.

### ScopedRef

ScopedRef stores a scoped resource and supports replacing it through a new acquisition. The previous value has its own release lifetime. Source, signatures, and options are in [ScopedRef](inventory/coordination/scopedref.md). Related exports include `fromAcquire`, `make`, `get`, `set`.

Good for: Hot reload of a resource with cleanup.

Not good for: Borrow counting or keyed pooling. RcRef and RcMap track borrowers. Pool bounds interchangeable resources.

Observed behavior and limits: Unverified at runtime. Acquisition failure and reader lifetime fit must be proved for a hot-swap integration.

Vivid: No concrete hand-rolled replacement established. Consult the catalog usage scan before adding one.

### Pool

Pool bounds acquired resources. makeWithTTL adds idle eviction. Size, concurrency, and utilization options are in the exact declarations. Borrowers use a Scope. Source, signatures, and options are in [Pool](inventory/coordination/pool.md). Related exports include `make`, `makeWithTTL`, `makeWithStrategy`, `get`, `use`, `reserve`, `invalidate`.

Good for: Reusable interchangeable connections or workers whose acquisition and release are owned.

Not good for: Caching arbitrary keyed results or promising strict person-specific FIFO admission. Cache and RcMap share by key. An admission queue owns waiting order.

Observed behavior and limits: Unverified at runtime. Pool capacity and invalidation integration require a proof before replacing admission code.

Vivid: Candidate PersonPool name in apps/server/src/code/pool.ts:47 is misleading as a fit signal. That type is a ticket queue, not an acquired resource pool.

### Cache

Cache memoizes keyed lookup results and pending work. make uses one TTL. makeWith computes TTL from Exit and key. capacity bounds entries. Lookup context options are in the declarations. Source, signatures, and options are in [Cache](inventory/coordination/cache.md). Related exports include `make`, `makeWith`, `get`, `getOption`, `getSuccess`, `set`, `has`, `refresh`, `invalidate`, `invalidateAll`.

Good for: Recomputable lookups, concurrent same-key deduplication, and explicit invalidation.

Not good for: External write replay or resource borrowing. An idempotency protocol protects writes. RcMap owns scoped resources. Zero failure TTL can prevent retention of transient failure.

Observed behavior and limits: Unverified at runtime in this investigation. Concurrent lookup behavior is source-verified in the catalog.

Vivid: No remaining manual TTL cache was established in the inspected candidates. The WeakRef family at packages/client/state/src/live.ts:290 preserves object identity and is not a normal lookup cache.

### ScopedCache

ScopedCache adds scoped acquisition and release to keyed cache entries. Its declarations specify lookup context and TTL options. Source, signatures, and options are in [ScopedCache](inventory/coordination/scopedcache.md). Related exports include `make`, `makeWith`, `get`, `refresh`, `invalidate`.

Good for: Cached resources whose cleanup follows cache ownership.

Not good for: Borrower-counted ownership. RcMap releases according to active borrowers. SQL durability needs a persistence module.

Observed behavior and limits: Unverified at runtime. Eviction while a caller holds a value needs source and integration review.

Vivid: No concrete hand-rolled replacement established. The RcMap in apps/server/src/code/pool.ts:124 needs borrower ownership, so it is not an automatic ScopedCache candidate.

### Request and RequestResolver

Request describes typed work. Effect.request sends it through a RequestResolver. The resolver groups entries, delays collection, runs batches, and completes every entry. batchN bounds one batch. Source, signatures, and options are in [RequestResolver](inventory/coordination/requestresolver.md). Related exports include `make`, `makeWith`, `makeGrouped`, `fromEffectTagged`, `batchN`, `setDelay`, `setDelayEffect`, `withCache`, `asCache`, `persisted`.

Good for: Collapsing many distinct keys into a real backend batch call.

Not good for: APIs that only accept one key per call. Bounded Effect.forEach is clearer there. A resolver does not itself make writes idempotent.

Observed behavior and limits: Unverified at runtime. RequestResolver.ts:175 requires all accepted entries to complete. Its preCheck false path needs another completion path.

Vivid: No proven batching replacement established. Pending callback RPC ids in apps/server/src/computers/signins/guest.ts:120 do not demonstrate a backend batch endpoint.

### Transactional state

Effect.tx commits changes to transactional in-memory structures. TxRef, TxDeferred, TxSemaphore, TxQueue, TxPubSub, TxSubscriptionRef, and TxPriorityQueue provide transactional companions. Source, signatures, and options are in [TxRef](inventory/transactions/txref.md). Related exports include `make`, `get`, `set`, `modify`, `update`.

Good for: Atomic coordination across several memory values and retry-on-conflict transactions.

Not good for: Database durability or exactly-once external effects. SQL transactions own durable records. External calls in a retried memory transaction can repeat.

Observed behavior and limits: Unverified at runtime. The catalog includes all public exports of these seven modules and Effect.tx and txRetry.

Vivid: No concrete replacement established. The durable Computer lifecycle at apps/server/src/computers/boat/lifecycle.ts:215 must retain its stored binding protocol.

### Schedule

Schedule computes continuation, output, and delay. Constructors describe cadence or backoff. Combinators bound, combine, inspect, or alter policies. Metadata includes input, attempt, now, start, elapsed, output, and duration. Source, signatures, and options are in [Schedule](inventory/time/schedule.md). Related exports include `spaced`, `fixed`, `windowed`, `exponential`, `fibonacci`, `recurs`, `once`, `forever`, `duration`, `during`, `cron`, `upTo`, `jittered`, `addDelay`, `modifyDelay`, `min`, `max`, `concat`, `concatResult`, `while`, `tap`, `map`, `passthrough`, `setInputType`, `fromStep`, `fromStepWithMetadata`, `toStep`, `toStepWithSleep`, `toStepWithMetadata`.

Good for: Retry policies, repeat cadence, bounded polling when no event exists, jitter, and time-based pacing.

Not good for: Absolute attempt deadlines or a substitute for an available completion signal. timeout bounds a wait. Deferred or a callback receipt signals readiness.

Observed behavior and limits: Runtime-proved. time.mjs prints 3 evaluations for upTo times 2. A duration 100 policy accepts steps at 0 and 100 and ends at 101. With 200 ms work and 100 ms spacing, starts are [0,300]. jittered samples for a 100 ms delay are [81.38313,80.570541,109.19449,95.224,114.344968,89.312355]. Source Schedule.ts:1487 scales by 0.8 to 1.2. Samples do not prove endpoints.

Vivid: Uses Schedule in apps/server/src/channels/worker.ts:6. Candidate manual two-second provider polling in apps/server/src/computers/boat/lifecycle.ts:190. Preserve its withdrawal behavior and elapsed deadline.

### Effect retry and repeat

retry reruns typed failures. repeat reruns successful effects. Options include schedule, times, while, and until. The source runs once before either policy is stepped. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `Retry`, `retry`, `retryOrElse`, `Repeat`, `repeat`, `repeatOrElse`, `schedule`, `scheduleFrom`, `forever`.

Good for: Idempotent transient retries and scoped workers with explicit failure policy.

Not good for: Retrying defects or interruptions, or repeating an uncertain external write. Preserve interruption and require a provider idempotency key or receipt for writes.

Observed behavior and limits: Runtime-proved. time.mjs observes 3 evaluations with 2 schedule outputs. Typed failure retry options are source-verified only.

Vivid: Uses Effect.repeat in apps/server/src/channels/worker.ts:59. Candidate recursive reconnect delay in packages/client/state/src/live.ts:171 can use Stream.retry with a typed retry policy.

### Timeout family

timeout fails with TimeoutError. timeoutOption returns None only when the timeout wins. timeoutOrElse runs a lazy fallback after the source is interrupted. timeoutTo is absent at this pin. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `timeout`, `timeoutOption`, `timeoutOrElse`, `delay`, `sleep`, `timed`.

Good for: Explicit time budgets for an awaited operation and distinct typed timeout outcomes.

Not good for: Guaranteed wall-clock return when cleanup or acquisition cannot be interrupted. None does not represent arbitrary failure or external cancellation. A timeout is not proof that a provider stopped.

Observed behavior and limits: Runtime-proved. time.mjs holds a 50 ms finalizer beyond a 100 ms timeout. No operator finishes at the deadline. timeout fails, timeoutOption returns None, timeoutOrElse runs fallback after release. External interruption stays interruption in all three.

Vivid: Uses Effect.timeoutOption in apps/desktop/src/main/control.ts:835. Candidate local timer in apps/server/src/computers/ssh/link.ts:455 must retain the TERM and channel-close protocol, not merely stop waiting.

### Clock, TestClock, and Duration

Clock supplies time and sleep. TestClock substitutes controllable time. Duration represents time quantities and provides constructors, comparisons, arithmetic, encoding, and conversions. Source, signatures, and options are in [Clock](inventory/time/clock.md). Related exports include `Clock`, `currentTimeMillis`, `currentTimeNanos`.

Good for: Typed time units and deterministic tests of sleeping fibers, schedules, retries, and Effect timeouts.

Not good for: Controlling Date.now or arbitrary platform timers through TestClock. Atom registry idle eviction uses Date.now and setTimeout, so the atom probe uses the supported Node mock clock instead.

Observed behavior and limits: Runtime-proved. time.mjs advances logical time with TestClock.adjust. atoms.mjs observes a 100 ms Atom TTL removed at 101 with timeoutResolution 1 and mocked wall time 0.

Vivid: Candidate Date.now and setTimeout stores in packages/client/state/src/texting.ts:207 and src/stream.ts:70. A one-shot display deadline still needs mount-owned cleanup.

### Stream callback and transport sources

Stream models many values with error and environment channels. callback adapts push producers through an owned queue. fromQueue consumes a dequeue. fromPubSub subscribes each consumer. Stream.async is absent at this pin. Source, signatures, and options are in [Stream](inventory/stream/stream.md). Related exports include `callback`, `fromQueue`, `fromPubSub`, `fromPubSubTake`, `fromAsyncIterable`.

Good for: Callback feeds, ordered events, pull consumers, and producer backpressure.

Not good for: One result or durable delivery. Effect.callback fits one callback result. A durable queue or event log supplies persistence.

Observed behavior and limits: Runtime-proved indirectly by the SubscriptionRef stream probe. General callback disposal and overflow are source-verified only.

Vivid: Candidate custom callback waiting set in apps/desktop/src/main/egress.ts:241. The public WebSocket API still lacks a drain receipt, so a scheduled adapter check can remain necessary.

### Stream debounce, throttle, and grouping

debounce emits after a quiet period. throttle controls throughput by units and duration with a cost function. groupedWithin emits groups bounded by size or elapsed time. schedule paces a stream through a Schedule. Source, signatures, and options are in [Stream](inventory/stream/stream.md). Related exports include `debounce`, `throttle`, `throttleEffect`, `groupedWithin`, `schedule`.

Good for: Search input, rate-shaped output, batched writes, and bounded latency groups.

Not good for: Debouncing owed work or substituting quiet-period debounce for a leading write plus cooldown. Queue coalescing plus a repeat policy can preserve those semantics.

Observed behavior and limits: Unverified at runtime. Exact throttle options and groupedWithin signatures are in the catalog.

Vivid: Uses Atom.debounce in packages/client/state/src/live.ts:430. Candidate manual persistence cadence in packages/client/state/src/snapshot.ts:202 must preserve its initial 500 ms delay and 10 second cooldown.

### Stream interruption and graceful halt

interruptWhen interrupts an in-progress upstream pull. haltWhen waits for the current pull and then stops. A pull can emit a whole chunk. The signal failure becomes stream failure. Source, signatures, and options are in [Stream](inventory/stream/stream.md). Related exports include `interruptWhen`, `haltWhen`.

Good for: Immediate cancellation or graceful stop at a pull boundary, chosen explicitly.

Not good for: Assuming one pull is one element. Chunk boundaries matter. Immediate truncation needs interruptWhen. An external accepted write still needs its own receipt.

Observed behavior and limits: Unverified at runtime. Source Stream.ts:18056 and :18182 documents the distinct pull behavior.

Vivid: Candidate manual read loop in apps/server/src/code/process.ts:373. Its protocol intentionally waits for accepted calls, so immediate interruption may be wrong.

### Stream broadcast and share

broadcast and broadcastN multicast through bounded or unbounded subscriber buffers. share starts upstream on first use and releases it after the last consumer, optionally after idleTimeToLive. replay is explicit. Source, signatures, and options are in [Stream](inventory/stream/stream.md). Related exports include `broadcast`, `broadcastN`, `share`.

Good for: Several consumers sharing one acquisition with explicit overflow and idle retention.

Not good for: Durable subscriber replay or independent restart positions. An event log with persisted cursors owns that contract.

Observed behavior and limits: Unverified directly at runtime. PubSub replay and backpressure were proved. Stream.share uses RcRef in Stream.ts:16787, but its complete integration was not run.

Vivid: Candidate subscription lifetime in packages/client/state/src/live.ts:383. Its Atom registry already owns stream lifetimes, so an additional share layer is not automatically needed.

### Atom and AtomRegistry

Atom describes reactive computation. AtomRegistry owns values, dependency links, subscriptions, schedules, and disposal. Atom.runtime builds service-backed reactive work. A registry is an independent cache and lifetime. Source, signatures, and options are in [Atom](inventory/reactivity/atom.md). Related exports include `make`, `readable`, `writable`, `runtime`, `context`.

Good for: Derived values and live queries whose dependencies can invalidate their results.

Not good for: A lifecycle event protocol or durable storage. An Effect Machine models accepted events and invokes. SQL owns durable server authority.

Observed behavior and limits: Runtime-proved. atoms.mjs observes no acquisition before mounting. The same script disposes an ordinary atom after its last mount leaves and the supplied scheduler runs.

Vivid: Uses Atom and AtomRegistry in packages/client/state/src/live.ts:370. Candidate custom elapsed store in packages/client/state/src/stream.ts:70 can use a mounted Effect atom.

### Atom keepAlive, idle TTL, and disposal

keepAlive retains an evaluated atom without subscribers. autoDispose restores disposal. setIdleTTL configures idle retention. Infinite TTL sets keepAlive. Registry defaultIdleTTL supplies a default. Source, signatures, and options are in [Atom](inventory/reactivity/atom.md). Related exports include `keepAlive`, `autoDispose`, `setIdleTTL`, `setLazy`, `mount`.

Good for: Warm queries, short unmount gaps, and one intentionally session-owned computation.

Not good for: Preloading by declaration alone or unlimited retention of high-cardinality keys. Mount starts ownership. Finite idle retention bounds unused lifetimes.

Observed behavior and limits: Runtime-proved. atoms.mjs retains keep after unmount, releases cold on scheduler flush, and releases idle at mocked time 101 for TTL 100 with resolution 1. registry.dispose releases keep too. Source AtomRegistry.ts:677 rounds into wall-clock buckets.

Vivid: Uses defaultIdleTTL in packages/client/state/src/live.ts:370 and keepAlive at :248. Candidate timer cleanup in src/stream.ts:70 belongs to the same registry lifetime if converted.

### Atom families

Atom.family memoizes an object factory by argument. The implementation uses weak values only when both WeakRef and FinalizationRegistry exist. Otherwise its MutableHashMap holds values strongly. Source, signatures, and options are in [Atom](inventory/reactivity/atom.md). Related exports include `family`.

Good for: Shared query or atom identity for equivalent keys.

Not good for: Assuming garbage collection or an idle TTL on every platform. Registry disposal and family identity retention are separate. A custom weak-key policy may be required when platform capabilities differ.

Observed behavior and limits: Unverified at runtime on Hermes. Source Atom.ts:1603 checks both globals. The family signature returns T extends object, so its result is not restricted to Atom.

Vivid: Candidate familyOf in packages/client/state/src/live.ts:283. Its Hermes branch preserves WeakRef without FinalizationRegistry, unlike this pin. A direct replacement has an unverified retention cost.

### Atom.fn and refresh

Atom.fn exposes an Effect or Stream function as a writable AsyncResult atom. Options include initialValue and concurrent. Reset and Interrupt are control writes. refresh invalidates and recomputes through the registry. Source, signatures, and options are in [Atom](inventory/reactivity/atom.md). Related exports include `fn`, `fnSync`, `Reset`, `Interrupt`, `refresh`, `getResult`, `set`, `update`.

Good for: Reactive commands and refreshable queries where AsyncResult is the full contract.

Not good for: A domain lifecycle requiring guarded events, attempt identity, dismissal, or idempotency. An Effect Machine owns that protocol. Concurrent writes do not imply SQL concurrency control.

Observed behavior and limits: Unverified at runtime. Source Atom.ts:1428 tracks concurrent fibers separately. Default replacement interrupts prior computation through its reactive lifetime.

Vivid: Uses a richer command and query layer in packages/client/state/src/live.ts:486. Candidate delayed choice submission in apps/mobile/src/screen/chat/Choices.tsx:189 belongs to a machine, rather than a bare Atom.fn conversion.

### Reactivity

Reactivity registers process-local callbacks by invalidation key. mutation invalidates after Effect success. query returns results through a queue. stream exposes query results as a Stream. Source, signatures, and options are in [Reactivity](inventory/reactivity/reactivity.md). Related exports include `make`, `mutation`, `query`, `stream`, `invalidate`, `layer`.

Good for: Local cache invalidation and rerunning keyed queries after mutations.

Not good for: A database changefeed or post-commit cross-process notification. The registered callbacks live in a Map. A transaction or durable transport must establish those other guarantees.

Observed behavior and limits: Unverified at runtime. Source Reactivity.ts:96 owns the handler map and :134 defines mutation with Effect.tap.

Vivid: Candidate session callback set in packages/client/state/src/live.ts:331. Preserve its synchronous unauthenticated notification semantics before replacing it.

### AtomRpc and AtomHttpApi

AtomRpc.Service derives reactive query, mutation, and stream access from RPC contracts. AtomHttpApi.Service does the corresponding work for an HttpApi. Constructors expose runtime and client options. Source, signatures, and options are in [AtomRpc](inventory/reactivity/atomrpc.md). Related exports include `Service`.

Good for: Typed client contracts, keyed query reuse, mutation invalidation, and reactive transport adapters.

Not good for: Inventing a second transport contract beside an existing typed client. A schema contract still defines the boundary. Durable state and post-commit notification remain server responsibilities.

Observed behavior and limits: Unverified at runtime. Exact Service options and model methods appear in the two catalog pages.

Vivid: Candidate packages/client/state/src/live.ts:383 wraps the existing VividRpcClient. packages/client/state/src/live.ts:106 documents a live-stream optimistic requirement that must survive a migration.

### Workflow, Activity, and durable coordination

Workflow defines payload, success, failure schemas, execution identity, registration, and execution operations. Activity records a named step through WorkflowEngine. DurableDeferred, DurableClock, and DurableQueue integrate waits and handoff with an engine. Source, signatures, and options are in [Workflow](inventory/workflow/workflow.md). Related exports include `make`.

Good for: Several steps that need recorded outcomes and restart recovery, when backed by a persistent engine and idempotent external operations.

Not good for: A client UI statechart or assuming durable behavior from the in-memory engine. Effect Machine owns the client lifecycle. A SQL-backed engine owns persistent workflow state.

Observed behavior and limits: Unverified at runtime. Source Workflow.ts:47 exposes the typed definition and WorkflowEngine dependency. Durable database and crash recovery were not exercised.

Vivid: No proposed replacement established for Vivid's durable server models. apps/server/src/computers/boat/lifecycle.ts:205 already has a stored binding and reconciliation protocol.

### Cluster and SingleRunner

ClusterWorkflowEngine implements WorkflowEngine with persisted cluster messages. SingleRunner.layer builds a single-process cluster with SQL message storage. ClusterSchema, ClusterCron, MachineId, and the other cluster modules appear in the catalog. Source, signatures, and options are in [ClusterWorkflowEngine](inventory/cluster/clusterworkflowengine.md). Related exports include `layer`.

Good for: Addressed entities, persisted RPC, and SQL-backed workflows in one process or a configured distributed deployment.

Not good for: A default event bus, a requirement to deploy several nodes, or authorization. PubSub handles local fanout. Company and Membership contracts define tenancy.

Observed behavior and limits: Unverified at runtime. Source cluster/SingleRunner.ts:69 requires SqlClient and Crypto even with in-memory runner storage. No SQL workflow integration or crash replay was run.

Vivid: No concrete replacement established. An adoption proposal must answer the durable fit check in references/CAPABILITIES.md using the installed paths corrected by this reference.

### Machine, State, Mailbox, and unstable names

The root source has no Machine.ts, State.ts, or Mailbox.ts. State types do exist in Scope, RcMap, ScopedCache, Pool, and TxQueue. Other state-named exports describe metrics, MCP protocols, SQL errors, and event-log transport. MachineId is a cluster identifier. Source, signatures, and options are in [Metric](inventory/discovery/metric.md). Related exports include `CounterState`, `FrequencyState`, `GaugeState`, `HistogramState`, `SummaryState`.

Good for: Locating the actual public module before choosing an implementation. The catalog discovery pages enumerate exported names containing Machine, State, Workflow, Activity, or Cluster outside the main inventory.

Not good for: Inferring a transition runtime from a State type name. @typeonce/effect-machine supplies the client machine in this repository. The installed Effect package has no src/unstable directory.

Observed behavior and limits: Runtime-proved. presence.mjs reports the three root modules absent, workflow and cluster directories present, and unstable absent. Absence is scoped to this installed package.

Vivid: Uses @typeonce/effect-machine through packages/client/state/src/connecting.ts:1. This inventory does not change that ownership.

### Single-result callback adaptation

Effect.callback registers a producer that resumes one Effect result. Registration can return cleanup. The signature exposes the AbortSignal and fiber-related adapter options. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `callback`.

Good for: One event receipt from a callback API and cleanup of listeners when the caller leaves.

Not good for: A multi-element feed. Stream.callback or a Queue fits repeated values. Resuming a callback does not undo a provider write after cancellation.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: Candidate callback command settlement in apps/server/src/computers/ssh/link.ts:441. Preserve its close and TERM behavior.

### Single-result memoization

These operations return a reusable Effect that caches one computation. TTL and explicit invalidation variants control when it is recomputed. Source, signatures, and options are in [Effect](inventory/lifetime/effect.md). Related exports include `cached`, `cachedWithTTL`, `cachedInvalidateWithTTL`.

Good for: Repeated reads of one expensive value within an explicitly owned runtime.

Not good for: Keyed lookup, scoped resource borrowing, and replaying an uncertain external write. Cache fits keys. RcRef fits a shared resource. A provider idempotency key protects writes.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### TestClock

TestClock provides a Clock implementation starting at logical time zero. adjust and setTime resume sleeps at the controlled time. withLive temporarily uses the live Clock. Source, signatures, and options are in [TestClock](inventory/time/testclock.md). Related exports include `make`, `layer`, `adjust`, `setTime`, `withLive`.

Good for: Deterministic Effect timeouts, retry delay, cadence, and resource idle release checks.

Not good for: Platform timers that read Date.now or setTimeout directly. The supported platform fake clock must control those APIs instead.

Observed behavior and limits: Runtime-proved. time.mjs advances schedules, timeouts, and RcMap release with TestClock.adjust. atoms.mjs uses the Node mock clock for its different timer boundary.

Vivid: Candidate manual timer state in packages/client/state/src/stream.ts:70. A converted Effect-owned timer would then be driven by TestClock.

### Duration

Duration represents time quantities and accepts documented numeric, tuple, bigint, and string inputs through its Input type. Construction, parsing, comparison, arithmetic, conversion, and formatting exports appear in the catalog. Source, signatures, and options are in [Duration](inventory/time/duration.md). Related exports include `Duration`, `Input`, `millis`, `seconds`, `zero`, `infinity`, `toMillis`, `isFinite`, `min`, `max`.

Good for: Keeping duration units explicit when configuring policies and adapter deadlines.

Not good for: An absolute timestamp or an elapsed deadline guarantee. Clock provides timestamps. timeout bounds a running operation subject to interruption and cleanup.

Observed behavior and limits: Runtime-proved as a dependency of time.mjs. Its seeded jitter uses Duration.toMillis. Parsing boundary failures and infinity conversions remain unverified.

Vivid: Uses Duration in apps/desktop/src/main/control.ts:835. Candidate raw milliseconds in apps/mobile/src/screen/computer/Live.tsx:77.

### AtomRef

AtomRef is a mutable reactive reference with synchronous subscribe, set, update, property references, and mapped read-only views. collection maintains reactive item references. Source, signatures, and options are in [AtomRef](inventory/reactivity/atomref.md). Related exports include `make`, `collection`.

Good for: Observable synchronous values with property-level projections.

Not good for: Async invocation ownership, guarded events, or persisted state. Atom and a machine supply different lifetime and protocol behavior. SQL supplies durable state.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### AsyncResult

AsyncResult represents initial, successful, and failed reactive results. Waiting and previous-success metadata preserve state during refresh. Source, signatures, and options are in [AsyncResult](inventory/reactivity/asyncresult.md). Related exports include `initial`, `success`, `failure`, `match`.

Good for: Query rendering with a previous successful value while a new result is pending.

Not good for: A domain event protocol. A machine models admissible actions and attempt identity rather than deriving them from query flags.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: Uses AsyncResult in packages/client/state/src/live.ts:17 and the projection at :78. No replacement established for that domain-specific projection.

### Hydration

Hydration serializes initialized serializable atoms from a registry and restores serialized values into a registry. Options and serialized metadata are in the catalog. Source, signatures, and options are in [Hydration](inventory/reactivity/hydration.md). Related exports include `dehydrate`, `hydrate`.

Good for: Transferring server-rendered or preloaded atom state into a client registry.

Not good for: A durable database or an offline conflict protocol. Snapshot ownership and persistence are distinct requirements.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### Activity

Activity wraps an Effect with a stable step name and result schemas. It executes through WorkflowEngine and WorkflowInstance. retry and idempotency helpers operate within that workflow context. Source, signatures, and options are in [Activity](inventory/workflow/activity.md). Related exports include `make`, `retry`, `idempotencyKey`, `raceAll`.

Good for: Recorded steps in a persistent workflow with explicit retry and provider deduplication.

Not good for: Exactly-once external effects. A provider call can happen before its outcome is recorded. Provider idempotency and durable reconciliation remain necessary.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### WorkflowEngine

WorkflowEngine is the execution and activity authority for workflow definitions. layerMemory supplies an in-process implementation. The engine interface includes durable-clock and deferred operations. Source, signatures, and options are in [WorkflowEngine](inventory/workflow/workflowengine.md). Related exports include `WorkflowEngine`, `WorkflowInstance`, `layerMemory`, `makeUnsafe`.

Good for: One engine boundary for workflow registration, execution, step results, and suspension.

Not good for: Assuming layerMemory survives process death. ClusterWorkflowEngine with SQL storage supplies the persistent implementation inspected here.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### DurableDeferred

DurableDeferred defines a schema-backed completion token whose result is stored through WorkflowEngine. Waiting can suspend a workflow. Source, signatures, and options are in [DurableDeferred](inventory/workflow/durabledeferred.md). Related exports include `make`, `await`, `succeed`, `fail`.

Good for: External approvals or inputs that need completion identity across workflow replay.

Not good for: Authorization or a reusable local gate. Membership authority must validate the completion. Deferred and Latch fit in-process waits.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### DurableClock

DurableClock schedules workflow wakeup through WorkflowEngine. sleep uses an in-memory activity at or below inMemoryThreshold and a durable clock for longer waits. Its options include name, duration, and inMemoryThreshold. Source, signatures, and options are in [DurableClock](inventory/workflow/durableclock.md). Related exports include `sleep`.

Good for: Long waits that must resume through a persistent workflow engine.

Not good for: Ordinary short in-process sleeps or assuming a memory engine persists timers. Clock and TestClock fit process-local time.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

### DurableQueue

DurableQueue combines PersistedQueue work with workflow result delivery. The model exposes typed offer and consumer operations. Source, signatures, and options are in [DurableQueue](inventory/workflow/durablequeue.md). Related exports include `make`.

Good for: Persisted handoff with workflow completion delivery.

Not good for: Broadcast history or stronger exactly-once execution claims. DurableQueue builds on a queue protocol and external writes still need deduplication.

Observed behavior and limits: Unverified at runtime. The linked declarations provide source signatures and options.

Vivid: No concrete replacement established. The catalog records lexical usage; aliased use remains unverified.

## Vivid patterns

The Vivid lines above name application candidates. A candidate is not a verified behavior-preserving replacement. The inspected source snapshot is `ffe9e196e183675bc0d22e774540e512a3f4d088`. For getters, guards, type helpers, and unsafe adapter variants, fit belongs to their owning capability. No independent hand-rolled replacement is claimed for each support API.

The strongest candidates are the recursive reconnect in `packages/client/state/src/live.ts:171`, the timer plus state pair in `apps/mobile/src/screen/chat/Choices.tsx:189`, the elapsed-time store in `packages/client/state/src/stream.ts:70`, the renewal timer in `apps/mobile/src/screen/computer/Live.tsx:75`, and retained child fibers in `apps/server/src/code/process.ts:371`. The renewal is a machine invoke using Clock and an explicit retry policy. A provider without a completion event can still need scheduled observation. The custom bounded FIFO in `apps/server/src/code/pool.ts:47` and the platform-specific weak family in `packages/client/state/src/live.ts:283` have extra guarantees that the nearest named module does not automatically replace.

## Verification limits

This investigation ran in-process SDK probes on Node, not Vivid product integration. It did not drive a phone, browser, database workflow, provider, or production system. Runtime behavior of unlisted cases remains unverified. A source description is not a guarantee of cross-process visibility, SQL commit order, exact-once execution, or native cancellation. Fresh-child skill routing and an independent cross-family review remain unverified because the task prohibits starting other agents.

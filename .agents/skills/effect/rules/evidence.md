# Runtime evidence

Run date 2026-10-24. Host `cloudbox-konan` was selected by `devbox-pick`. It reported load 0.21 on 8 cores and 6,785 MB available before these short probes. Production was not accessed. Every script exited 0. The scripts first existed under `/tmp/effect-dig/`; the committed copies are in [scripts/probes](../scripts/probes/).

## Package identity

Both required local resolution commands returned the same `<repo>/node_modules/.pnpm/effect@4.0.2/node_modules/effect/package.json`. Local Node was v24.14.1. The development box used v24.18.1. `identity.mjs` hashed every installed source TypeScript file, runtime JavaScript file, and declaration file in sorted path order. The complete digest matched on both machines.

The exact runtime command was `node /tmp/effect-dig/<probe>.mjs <resolved-effect-package-directory>`. The installed directory came from the existing gate checkout on the development box. The scripts load that directory directly and assert version 4.0.2. No dependency install, SDK internal override, product fixture, or database was involved.

## identity

Script [identity.mjs](../scripts/probes/identity.mjs). Stdout follows.

```text
Effect.version "4.0.2"
Node.version "v24.18.1"
Effect.sourceAndRuntimeSha256 "e52426faf47c0be81759013ebe1d5b1312314e9879242d1908f21ff0a8914530"
```

## presence

Script [presence.mjs](../scripts/probes/presence.mjs). Stdout follows.

```text
Machine.rootModuleExists false
State.rootModuleExists false
Mailbox.rootModuleExists false
Effect.fork.exists false
Effect.forkChild.exists true
Effect.forkScoped.exists true
Effect.forkIn.exists true
Effect.timeout.exists true
Effect.timeoutOption.exists true
Effect.timeoutTo.exists false
Effect.timeoutOrElse.exists true
Stream.callback.exists true
Stream.async.exists false
Stream.interruptWhen.exists true
Stream.haltWhen.exists true
Stream.share.exists true
Stream.broadcast.exists true
Stream.broadcastN.exists true
reactivity.Atom.exists true
reactivity.AtomRegistry.exists true
reactivity.AtomRpc.exists true
reactivity.AtomHttpApi.exists true
reactivity.Reactivity.exists true
workflow.sourceDirectoryExists true
cluster.sourceDirectoryExists true
unstable.sourceDirectoryExists false
```

## coordination

Script [coordination.mjs](../scripts/probes/coordination.mjs). Stdout follows.

```text
Deferred.wakeOrder [1,3]
Latch.wakeOrder [1,3]
Latch.releaseKeepsClosed true
Semaphore.mixedPermitOrder ["small","large"]
Semaphore.equalPermitOrder [1,2,3]
Queue.shutdown {"blockedOffer":false,"takeInterrupted":true,"size":0}
Queue.pendingTakeInterrupted true
Queue.end {"drained":"retained","terminal":"Failure","cause":["Fail"]}
PubSub.lateReplay [2,3]
PubSub.defaultReplay 0
PubSub.backpressureWaitsForAll true
SubscriptionRef.changes [0,1,1,2]
```

## lifetime

Script [lifetime.mjs](../scripts/probes/lifetime.mjs). Stdout follows.

```text
interruption.finalizers ["onInterrupt","ensuring","resource-b","resource-a","onExit","interrupt-returned"]
scope.defaultCloseOrder ["child",2,1]
uninterruptibleMask.restore ["acquisition-complete","finalizer","interruption-complete"]
```

## time

Script [time.mjs](../scripts/probes/time.mjs). Stdout follows.

```text
Schedule.jittered.seededMillis [81.38313,80.570541,109.19449,95.224,114.344968,89.312355]
Schedule.upTo.times2.evaluations 3
Schedule.upTo.duration100.at0_100_101 ["Success","Success","Failure"]
Schedule.upTo.duration100.work200.starts [0,300]
RcMap.idleRelease {"acquired":1,"reused":1,"released":[["x",1199]]}
Effect.timeout {"atDeadline":[],"events":["released"],"exit":"Failure","value":["TimeoutError"],"externalInterrupted":true}
Effect.timeoutOption {"atDeadline":[],"events":["released"],"exit":"Success","value":{"_id":"Option","_tag":"None"},"externalInterrupted":true}
Effect.timeoutOrElse {"atDeadline":[],"events":["released","fallback"],"exit":"Success","value":"fallback","externalInterrupted":true}
```

## atoms

Script [atoms.mjs](../scripts/probes/atoms.mjs). Stdout follows.

```text
Atom.idleDisposal {"beforeRead":[],"releasedAt100":false,"releasedAt101":true,"events":["acquire-cold","acquire-keep","acquire-idle","release-cold","release-idle"]}
Atom.keepAlive.registryDispose ["acquire-cold","acquire-keep","acquire-idle","release-cold","release-idle","release-keep"]
```

## Interpretation and limits

- `coordination.mjs` starts waiters immediately before releasing the gate. It cancels waiter 2. The observed FIFO order is the surviving waiters, not a guarantee about completion order after arbitrary awaited work. Semaphore serves equal requests in observed registration order and lets a later smaller request pass an earlier larger one.
- Queue shutdown discards buffered messages. A suspended offer returns false. Suspended or subsequent takes interrupt. `end` retains the buffered item and then produces Done through the error channel. The printed Fail reason is the Done completion value, not a claimed typed application failure.
- PubSub replay is explicit. Two messages are retained for a late subscription even without current subscribers. Default replay is zero. Backpressure waits for every current subscriber to release the occupied slot. Overflow variants and unsubscribe races remain unverified at runtime.
- SubscriptionRef emits the initial value, then every tested write in order, including the repeated value 1. Concurrent effectful modifiers were inspected in source but were not run in this investigation.
- `lifetime.mjs` installs interruption handlers before publishing readiness. An earlier attempt published readiness before those handlers were entered. That probe omitted their output because interruption arrived first. The corrected probe places the signal inside the protected Effect. Finalizer order applies to this nesting and the default sequential scope. Parallel finalizer completion order remains unverified.
- The mask probe requests interruption while acquisition waits. Acquisition completes before restore delivers the pending interruption. The finalizer runs before Fiber.interrupt returns.
- `time.mjs` uses TestClock and a seeded Random. The six jitter samples lie inside 80 to 120 ms for a base delay of 100 ms. The source formula establishes the scale interval; these samples do not establish endpoint attainability or a statistical distribution.
- Schedule.upTo counts additional schedule outputs. The duration predicate accepts equality. It checks schedule metadata rather than enforcing a deadline over work and sleep. The long-work probe starts at 0 and 300 despite the duration limit of 100.
- RcMap idle release is measured against logical clock 1000 after the preceding schedule probe. The first scope closes at 1000. A new scope uses the same resource at 1099. The final release occurs at 1199, 100 ms after that scope closes. There was no release at either 99 ms checkpoint. Capacity eviction, interrupted lookups, and simultaneous borrowing remain unverified at runtime.
- Each timeout interrupts the source at 100 ms and waits for its 50 ms finalizer. The fallback runs after release. External interruption remains interruption and does not turn into None or fallback. Uninterruptible source work can extend the return time further; this investigation proved the finite finalizer case.
- `atoms.mjs` uses Node's supported mock timer API for Date and setTimeout, plus AtomRegistry.make scheduleTask. It does not replace Effect internals. The ordinary atom releases after the controlled scheduler flush. With wall time 0, idle TTL 100, and timeoutResolution 1, removal occurs at 101. This probes bucket rounding rather than promising an exact timer deadline. A keepAlive atom releases on registry disposal. Hermes, garbage collection, and native timer suspension remain unverified.

## Review limits

The API catalog is generated from actual installed source and declarations. Runtime proof is limited to the outputs above. No Vivid feature behavior changed, so no product-client integration was run. Fresh-child skill discovery and independent cross-family review were not run because the task explicitly prohibits starting other agents. They remain pending for the parent.

# Effect Machine stress observations

READER: agent

These are observed results for 0.46.0 on Effect 4.0.2 and Node 24.18.1, recorded on 24 October 2026. They describe the tested schedules. They do not prove correctness for every possible interleaving. Unexecuted behavior is marked unverified.

## Environment and reproduction

`devbox-pick` selected `cloudbox-konan`. The measured host had 8 cores, load 0.70, approximately 10 GiB available memory, and no used swap before the finishing runs. No production host, production account, app database, or product runtime was accessed.

The requested local workspace contained only effect-machine 0.40.0. Origin main pinned 0.46.0. The source clone used the package-scoped `@typeonce/effect-machine@0.46.0` tag at commit `6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc`. A `v0.46.0` clone attempt failed because that tag does not exist. The cloned Machine.ts and a local Vivid 0.46.0 installation had identical SHA-256 `0de523d7432a43ef15768db7385d3fa76f91798e2fb6fe88e333d3c4c560ff84`.

Scripts live under `/tmp/em-stress/` on the devbox, with copies on the investigating machine. They are outside the repository and are never committed. They import published 0.46.0. The finishing runs use `--import ./workspace.mjs`. Its loader resolves effect-machine and Effect from an isolated copy of Vivid's installed devbox workspace packages under `/tmp/em-stress/workspace/node_modules`. Copying avoids another gate replacing a warm tree during a probe. Vivid's installed and the isolated registry installation's `dist/Machine.js` had identical SHA-256 `fc777746be91d605a3cae77f73bf805ee4c28a4ee1c643450baa954efb63c794`.

React, react-dom, and react-test-renderer are 19.2.3. The React bridge and plugin are 0.46.0. `package.json`, the pnpm lockfile, `runtime-exports.json`, and the copied packages remain in the evidence directory. `runtime-exports.mjs` imported all core, reactivity, testing, cluster, React, and lint runtime exports. Importing cluster did not execute a Cluster server.

Run the suite on a devbox from that directory:

```bash
bash /tmp/em-stress/run.sh
node --import ./workspace.mjs --expose-gc burst.mjs
```

The suite receipt was `ALL REQUESTED NODE PROBES FINISHED`. Final result files are `races.jsonl`, `cancellation.jsonl`, `parallel.jsonl`, `children.jsonl`, `atoms.jsonl`, `resume.jsonl`, `timer.jsonl`, `react.json`, `react-ssr.json`, `storm.jsonl`, `storm-million.jsonl`, and `burst.jsonl`. The corresponding final stderr files were empty except React's test-renderer deprecation warning. Development probes named debug, childdebug, and original are not part of the suite receipt.

The race and lifetime cases use deterministic schedules with repetition indices 0 through 99. Those indices are not random seeds. Five storm runs alternate ref and atom. No random scheduler exploration was performed. Deferred receipts and observable snapshots control concurrency. GC probes advance event-loop turns with setImmediate. Timer probes use a real 1 ms timer for the queue race and TestClock for elapsed-time assertions. There are no guessed completion sleeps.

## Results

| Case | Result | Observed counts and evidence |
| --- | --- | --- |
| Effect success after replacement | Breaks without identity | `races.mjs`. Old result landed in 100/100 unguarded trials with reenter and 100/100 without it. Guarded trials had 0/100 stale results in each mode. |
| Typed Effect failure after replacement | Breaks without identity | `races.mjs`. 100/100 stale failures per unguarded mode. 0/100 per guarded mode. |
| Stream element after replacement | Breaks without identity | `races.mjs`. 100/100 stale elements per unguarded mode. 0/100 per guarded mode. |
| Timer after replacement | Breaks without identity | `races.mjs`. 100/100 old expiries per unguarded mode. A known first-attempt sentinel guard rejected 100/100 in each mode. Bare timers do not return an attempt id. |
| Child completion after replacement | Breaks without identity | `races.mjs`. 100/100 stale completions per unguarded mode. 0/100 per guarded mode. |
| Idle event storms | Holds for this producer | `storm.mjs`. Five runs per mode at 200,000 events, then five at 1,000,000. Each run accepted half and refused half. Every final count matched. FIFO errors were zero. |
| Busy mailbox bursts | Holds for this producer | `burst.mjs`. Five runs per mode queued 100,000 events behind a suspended finalizer. Each had 50,000 accepted and 50,000 refused events. Every final count matched. FIFO errors were zero. |
| Mid-fetch cancellation | Holds | `cancellation.mjs`. 100 received HTTP requests, 100 AbortSignal notifications, 100 server close receipts, and 100 finalizers. |
| Parallel transitions and completion | Holds | `parallel.mjs`. Both regions completed from one event in 100/100 trials. |
| Conflicting owner updates | Selects one update | `parallel.mjs`. Left +1 and right +10 competed for the same owner. The result was 1 in 100/100 trials, never 11. This does not demonstrate a library defect. |
| Invoked versus spawned child lifetime | Holds | `children.mjs`. Invoked children stopped on state exit. Spawned children survived it in 100/100 trials. All 200 child invokes finalized once. |
| Duplicate child ids and stop races | Holds | `children.mjs`. 100 typed ChildAlreadyExistsError results. All 100 dynamic descriptors were absent after stop. Duplicate stop calls did not duplicate finalizers. |
| Startup send FIFO | Holds | `atoms.mjs`. 100/100 trials held writes during a gated layer build, then produced digits 123. |
| Startup send failure | Holds | `atoms.mjs`. 100/100 waiting writes failed with StartupFailed when layer construction failed. |
| Registry dispose mid-invoke | Holds | `atoms.mjs`. 100/100 registries stopped their machine and interrupted its invoke. |
| Idle TTL | Holds for tested registry | `atoms.mjs`. 100/100 last-unmount cases stopped with defaultIdleTTL 1 ms and timeoutResolution 1 ms. |
| Family GC | Holds after ownership release | `atoms.mjs`, with --expose-gc. 100/100 abandoned family projection atoms collected after unmount and registry disposal. Total suite invoke starts and finalizers both equalled 400. GC alone was not a cancellation signal. |
| Snapshot replay | Restarts work | `resume.mjs`. 100 original starts plus 100 resumes restarted Effect, Stream, and child work. Starts and finalizers both equalled 600. Initial constructors and entry callbacks ran only 100 times. |
| Timer resume | Restarts full delay | `timer.mjs`. 100/100 trials remained active 600 ms after resuming a timer already 600 ms into a 1,000 ms delay. Completion required a fresh full 1,000 ms. |
| React StrictMode owner | Holds in test renderer | `react.mjs`. 100 owners, 200 factory evaluations, 100 runtime starts, 100 stops, maximum one active invoke. MachineState rendered 7 in every trial. |
| Server rendering | Starts no work | `react.mjs --ssr`, in a separate process. 100 renders produced `<b>7</b>`. Runtime starts and stops were zero. |
| Hermes | Not run | No attached emulator. The supplied recipe's scripts/start.sh and base.apk were missing. See prerequisites below. |

## Reentry interpretation

`races.mjs` holds the parent drain behind a parallel sibling's asynchronous finalizer. It writes attempt 2, lets attempt 1 queue its outcome, then releases the drain. It waits for the old outcome's EventProcessed inspection record before checking state. EventSent alone was too early. The finishing matrix has 5 source kinds times 2 reentry settings times 2 guard settings times 100 repetitions, or 2,000 trials.

Without reenter, changing a self-target's data retains its old invoke. One start per trial is expected. Its completion consequently contains the old input. This mode demonstrates retained-input semantics, not an interruption defect. With reenter, two starts occur and the old work is replaced. An already queued old result can still complete the new attempt. Unguarded replacement fails in all 100 deliberately arranged schedules per source kind. Those are reproduction rates under one forced interleaving, not population failure probabilities.

The guarded timer cell compares a known old sentinel with the new state's id. It demonstrates that routing can be declined. It does not show that a bare timer has an id-bearing output. For real attempt-sensitive deadlines, an Effect can delay and return its captured id. That exact application recipe was not separately stress-tested, so its combined runtime behavior is unverified. Effect output identity and timer cancellation were tested separately.

The routing mechanism is visible in upstream [invocation.ts:244](https://github.com/typeonce-dev/effect-machine/blob/6aed0d3b7edef3fce403b8543fb8ebc403b0c0bc/packages/effect-machine/src/internal/machine/invocation.ts#L244), `invocationEvent.ts:14`, and `planner.ts:1083`. Ownership is checked before send. Queued messages carry path and invoke id, not generation. The planner matches active path and id. No SDK internals were patched.

## Throughput and memory

These are descriptive microbenchmarks. Each timed run constructs events, sends them through a single JavaScript producer, and consumes the resulting counter. Half the events are deliberately refused. The counts and FIFO assertions run before disposal. These numbers are not accepted-transition rates and do not measure a Vivid user action.

| Run shape | API | Runs | Median events/s | Range events/s | First heap before | Final heap after GC | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 200,000 idle | ref | 5 | 929,452 | 859,658 to 983,581 | 20.92 MiB | 23.06 MiB | 283.98 MiB |
| 200,000 idle | atom | 5 | 850,063 | 769,771 to 860,140 | 22.00 MiB | 23.15 MiB | 283.98 MiB |
| 1,000,000 idle | ref | 5 | 1,003,657 | 959,029 to 1,062,384 | 20.92 MiB | 21.61 MiB | 388.64 MiB |
| 1,000,000 idle | atom | 5 | 888,346 | 866,575 to 895,222 | 22.51 MiB | 21.69 MiB | 388.89 MiB |
| 100,000 queued | ref | 5 | 643,310 | 557,085 to 719,433 | 20.81 MiB | 26.92 MiB | 306.83 MiB |
| 100,000 queued | atom | 5 | 591,507 | 554,116 to 632,129 | 25.74 MiB | 27.16 MiB | 305.96 MiB |

Busy-burst peak queued heaps were 87.89 MiB for ref and 99.98 MiB for atom. RSS retained V8 allocation and differed from live heap. No unbounded-growth conclusion follows from five finite runs. An indefinitely flooded mailbox, GC under sustained UI subscriptions, and a multi-producer workload remain unverified.

The separately profiled run is `profile.jsonl` with `storm.cpuprofile`. Its throughput is excluded from the table. CPU self-samples include event construction, flat planning, atom updates, Effect scheduling, and garbage collection. The profile also includes module loading and loader hooks. It does not isolate a single production bottleneck. A performance comparison or end-to-end speedup claim is therefore inconclusive. The measured counts are valid for this one synchronous producer.

## Vivid defects and upstream draft

No Vivid defect was confirmed by a product-runtime reproduction in this investigation. `packages/client/state/src/feed.ts:344` and `feed.ts:352` now decline mismatched delivery outcomes. `connecting.ts:446`, `connecting.ts:476`, and `connecting.ts:530` check attempt-bearing outcomes. The stale skill statements describing these guards as missing were corrected from source at main ffe9e196e. These source checks are not a real-client proof of those workflows.

`/tmp/em-stress/upstream-1.md` is a draft extending the already documented mailbox-generation race to the tested source kinds. It has not been filed. The investigation found no separately confirmed new library bug. Conflicting owner updates and non-reenter input retention match selection and lifetime semantics.

## Unexecuted checks

Hermes is unverified. The selected devbox's `adb devices` returned an empty list. `ls` reported both `~/vivid-emulator/scripts/start.sh` and `~/vivid-emulator/base.apk` missing. The Android SDK, emulator executable, and adb existed. The supplied recipe could not run as written. It needs a working start script and AVD, a local proof APK or Hermes host using these exact packages, and a nonproduction bundle. The memory recipe describes an app signed into production, which is outside this task's access limit. No production APK was opened and no emulator rebuild was started.

Real DOM hydration, focus retention, React Native StrictMode, native mobile performance, non-V8 WeakRef behavior, and a missing-WeakRef fallback were not run. React proof used react-test-renderer and a separate react-dom/server process. The renderer emits its deprecation warning. That warning is preserved in react.err.

History, choice, parent protocols, custom logic, commands other than child stop, invalid snapshot migrations, and the full upstream test suite were inspected in source but not separately executed. MachineTest, Cluster persistence, and devtools were inventoried rather than booted. Their runtime behavior remains unverified here. No production code was changed.

## Documentation gate

`pnpm gate --only policy,lint,format --host cloudbox-konan` passed with receipt `gate full PASS sha=ffe9e196e183+uncommitted run=mvmd9vspddd2dd`. Policy ran 11 checks. Lint replayed 12 cached tasks. Format passed. The word full is the gate mode label. Only the three requested stages ran.

The new worktree has no node_modules. The local gate launcher used `NODE_OPTIONS='--import /tmp/em-stress/local-workspace.mjs'` to resolve its transport dependencies from an isolated `/tmp/em-stress/gate` install of Effect 4.0.2, oxc-parser 0.154.0, and tsc-rs 0.8.0. The remote checks used the gate's normal pinned workspace install. No repository manifest or lockfile changed.

The full merge gate was not run. The pre-push runtime gate is unrelated to this documentation-only diff and is bypassed for this push. Independent cross-family review remains pending. No other agents were started under the brief's explicit limit.

# Capabilities: inspect the official module before writing one

Read this before designing or hand-rolling anything that owes work across a crash, waits for a person or a clock, fans out changes, isolates CPU, or persists client state. Its job is discovery: which official Effect module to inspect, and what that module must be proved to guarantee before it is adopted or rejected.

Module facts below were read from source at the pin current when this was written. `AGENTS.md` owns the exact pin. Re-read the source when the pin moves; this file is a map, not the proof.

## Source protocol

1. **Installed first.** Read the pinned `effect` package's `package.json` exports and the group barrel: `persistence`, `workflow`, `eventlog`, `cluster`, `rpc`, `workers`, `reactivity`. On the current pin these live under `effect/unstable/<group>`. List the barrel; module names recalled from memory or copied from this table are leads only.
2. **Then newer official source, when the pin lacks the capability or carries a defect.** Compare the latest official release, then unreleased `main`, in the canonical [`Effect-TS/effect`](https://github.com/Effect-TS/effect) repository. Label every fact *installed*, *released* or *unreleased*. The older `effect-smol` repository and old snapshot tags are stale for v4.
3. **Newer source is evidence only.** Keep the installed import paths (stable releases move them). An upgrade is separate work under the lockstep rule in `AGENTS.md`; propose it, never fold it into a feature.

## Classify the need

Name which of these the design needs, one by one: **in-memory coordination**, **SQL durability**, **network transport**, **post-commit notification**. Most wrong picks come from a module that supplies one being taken for another.

## Choose

| Need | Inspect first | It supplies | It does not supply |
| --- | --- | --- | --- |
| Owed work, each item handled by one consumer: job, ingestion, outbox handoff | `PersistedQueue` (persistence) | SQL backlog, competing consumption, leases with refresh, scoped acknowledgement, attempts, dead letters. At-least-once. | Cross-process push: the wake is process-local and fires at offer, possibly before the outer commit; other processes poll. No cursor replay, no broadcast. |
| Several durable steps, a durable wait (Approval, Input request, long delay), crash replay | `Workflow`, `Activity`, `DurableDeferred`, `DurableClock` on `ClusterWorkflowEngine.layer` + `SingleRunner.layer` | A real one-process engine on the existing SQL client: no multi-node deployment. Stored step results, durable completion tokens, persisted long sleeps. Explicit retry: `Activity.retry` around an Activity re-runs it under an in-memory `Effect.retry`; each attempt has its own stored result. | Automatic redelivery: a failed step with no retry policy is stored as the result and returned on replay. Retry state that survives a restart: replay walks the stored failed attempts and sleeps the schedule again, so a long backoff belongs on `DurableClock`. Exactly-once: an effect done before its exit is stored can run again (`Activity.idempotencyKey` only helps the provider dedupe). Authorization: a token is identity. Row cleanup. `WorkflowEngine.layerMemory` keeps nothing across restart. |
| Addressed durable command to one entity | Persisted cluster RPC: `ClusterSchema.Persisted`, `SqlMessageStorage` | Durable mailbox, replies, duplicate keys, delayed delivery | `Persisted` is off by default. A stored failure reply is a reply. Not an owner-wide broadcast. `WithTransaction` is opt-in and does not prove post-commit emission. |
| Replicated event history between peers | `EventLog`, `EventJournal` and their SQL stores (eventlog) | Durable entries, replication positions, backlog replay | Positions are not acknowledgements or poison states. Publication goes to a process-local `PubSub` inside the transaction, before the outer commit. No cross-process wake. |
| Realtime invalidation, typed client queries and mutations | `Reactivity`, `AtomRpc`, `Atom` | Query and mutation families, stream pulls, TTL, optimistic helpers, invalidation keys | A database changefeed: `Reactivity` is local callbacks fired on effect success, not on SQL commit. Compare with the shared client state already in the repository first. |
| Coordination scoped to one process and one lifetime | `Queue`, `PubSub`, `SubscriptionRef`, `Deferred`, `Scope` (see `STREAMS.md`) | Backpressure, fanout, latest value, interruption | Anything after a restart. Correct when the obligation is not owed. |
| CPU-bound work off the main thread | `Worker`, the RPC worker protocol, the platform worker layer | Readiness, typed protocol, pool, scoped termination | A backlog or acknowledgement: the durable handoff stays in a queue. A cancel message cannot stop synchronous code; end the thread through its scope. A heap limit is not a memory limit. No native mobile adapter was found. |
| Persistent preferences, offline cache | `KeyValueStore` with `toSchemaStore` and its SQL, file and web-storage layers; `Atom.kvs` | Typed keyed values; the SQL layer joins that client's transaction | Cursors, claims, relations, indexes. `modify` is read-then-write. `Atom.kvs` is not an awaited write receipt. |
| Recomputable result with a TTL | `Cache` (see `CACHING.md`), `PersistedCache`, `Persistence` backings | Stored exits with TTL | Job delivery or an event feed |
| Closed set of states | `Schema.TaggedUnion` (see `SCHEMA.md`) | Cases, constructors, guards, exhaustive match | Transition graph, persistence, lifecycle |
| Atomic change to several in-memory values | `Effect.tx`, `TxRef` and the `Tx*` structures | A memory journal that retries on conflict | Durability. SQL or external effects in the body are outside the journal and can repeat; it cannot commit a row plus a notification. |

**State machine runtime.** The official `Machine` module was not ported to v4; the [migration annotation](https://github.com/Effect-TS/effect/blob/395f256c223fa839585971254f0a7b48a903dd1f/migration/annotations/effect__experimental__Machine.yaml) records it as having no replacement. A third-party machine library is a separate candidate with its own semantics: read the source of the version you would install and judge it on the fit check below. A transition count is no reason to adopt or reject it, and no machine replaces SQL authority or an external receipt.

## Fit check

A candidate fits when every applicable line is answered from source, with file and symbol:

- **Transaction join.** Does the write share the product transaction? That needs the same `SqlClient` identity and fiber transaction context; a nested transaction is a savepoint.
- **Commit and publication.** When does the wake or publish happen relative to the outer commit, and which processes see it?
- **Crash replay.** Where does the state live, and what runs again after the process dies mid-step?
- **Delivery.** At-least-once needs an idempotent handler. What happens when an external effect ran but its outcome was never stored?
- **Leases, acknowledgement, poison.** Lease expiry, attempt ceiling, dead-letter behavior, and what a terminal entry leaves waiting.
- **Cursors and fanout.** Does each consumer hold its own position, or do consumers compete?
- **Failure meaning.** Is a failure stored as the answer, or retried?
- **Scope, cancellation, bounds.** What owns the fiber, thread or connection, what ends it, and what caps its time and memory?

Each answer carries one of three labels, in the design and in the JSDoc:

- **Source-verified**: cited to installed source, file and symbol. This is the bar for every answer, and it is enough for what the module does on its own.
- **Runtime-proved**: a behavioral test through the real seam (real PostgreSQL, a real thread or process, per the test rules in `AGENTS.md`). Owe one for each guarantee that Vivid's integration leans on and that source alone cannot settle: the transaction join with our client, crash replay of our handler, post-commit visibility to our subscribers. The test asserts Vivid's observable behavior, so a test that only re-proves the SDK primitive is a tautology and is left unwritten.
- **Unverified**: neither yet. Say what would settle it.

## Judge by guarantees, not names

- **"cluster" is not a deployment.** `SingleRunner.layer` assembles a one-process engine. What decides a workflow engine is in its source: how a failure is stored, whether the enqueue can block inside the product transaction, and who deletes its rows.
- **"durable" is not redelivery.** `Workflow` keeps a failure as the result unless the step carries `Activity.retry`. `DurableQueue` wraps the same `PersistedQueue` and adds result delivery; it is not a stronger queue.
- **"event log" is not a bus**, and `PubSub`, `Queue`, STM and `Schema` are not durability.
- **Open gaps: do not report these as fixed without re-reading source.** `PersistedQueue`'s wake is process-local and can precede commit. The SQL event logs publish process-locally before the outer commit. The PostgreSQL client's `notify` takes its own pooled connection, outside the writing transaction.

When no module fits, write the owned module and say in its JSDoc which candidates were inspected and which guarantee each one failed.

# Runtime platform research

Status: Flue Node selected, 2 September 2026. Cloud and executor adapters remain replaceable.

## The answer

Vivid should begin as **one ordinary, long-lived program** that owns the agent loop, durable state, scheduling, tools, and computer. It should run locally with one command and deploy unchanged in one container or VM.

The selected agent core is **Flue Node with file-backed SQLite**. Flue—not SQLite by itself—owns
durable admission, ordering, the conversation journal, recovery, and client observation. Effect
structures the surrounding product runtime. AI Elements renders the client view model.

Cloudflare should not be the canonical runtime. It may later provide ingress, a relay, or an optional deployment adapter. The core must not require Durable Objects, Worker bindings, a provider queue, or object storage merely to boot.

“One program” means one product installation and operational unit, not necessarily one PID:

- one version and deployable artifact;
- one state directory;
- one start/stop/restart lifecycle;
- one API and health surface;
- internally supervised Chromium, MCP servers, and isolated executors when needed.

That gives Vivid the whole-machine capabilities it needs without forcing every safety boundary to become a separately deployed cloud service.

## Names recovered from the dictated prompt

- **Cloudflare OS** is the Cloudflare Workers project in `~/os`. Its own README says it is built “by the Workers team,” not the Astro team.
- **Flue** is the agent framework from the Astro team. “Flew” was a transcription of Flue, not Fly.io.
- **Vivid** is this product, not Vercel.
- **celld** is Ryan Dahl’s project in `~/celld`. “3D” was a transcription of celld, not Deno generally.

Astro Technology Company [joined Cloudflare in January 2026](https://astro.build/blog/joining-cloudflare/), which may explain why Cloudflare and Astro were adjacent in the prompt. This is context, not evidence that Astro built Cloudflare OS.

## Recommended shape

```text
one Vivid installation
└── vivid daemon — normal Linux/macOS process
    ├── built Vite UI + HTTP/WebSocket API
    ├── Flue Node agent runtime
    │   ├── model loop
    │   ├── per-agent/session mailbox
    │   ├── interruption and approvals
    │   └── restart recovery
    ├── scheduler, attention state, and organization routing
    ├── file-backed SQLite + local artifacts
    ├── computer adapter
    │   ├── this machine
    │   └── remote full Linux machine
    └── supervised child processes
        ├── browser/desktop
        ├── MCP and tool processes
        └── isolated executor
```

The web, desktop, and mobile apps are clients of this one runtime protocol. The runtime and its computer belong together. A remote deployment is the same program running on a remote machine, not a second implementation.

### Phone access is a runtime requirement

The phone is a thin remote client of the same live Vivid runtime, not a smaller agent runtime. A person must be able to start work on desktop, leave, then use the phone to watch progress, answer a question, approve or reject an action, send another instruction, inspect artifacts, and—when appropriate—control the remote browser/computer.

That requires the runtime protocol to support:

- one stable runtime and teammate identity across devices;
- multiple simultaneous clients with cursored replay and reconnect;
- idempotent commands and durable read/attention state per user;
- approvals and interruption from any authorized client;
- push notifications for needs-input, approval, failure, and completion;
- a secure reachability layer for a runtime behind NAT, without making the relay authoritative for agent state;
- a separate low-bandwidth computer-view/input stream suitable for mobile.

The honest availability boundary is machine uptime. A laptop-hosted runtime is remotely reachable only while that laptop and daemon are awake. Always-available phone access therefore needs the same Vivid installation running on an always-on home machine or generic VM; it does not require a different Cloudflare-native runtime.

Start with one live owner for each Vivid instance or agent. Recover it after a crash. Scale first by placing whole instances on more machines. Active-active execution and distributed consensus are not first-version requirements.

## What belongs in the portable core

| Core owns                                                     | Host/provider adapter owns              |
| ------------------------------------------------------------- | --------------------------------------- |
| Agent state machine and event semantics                       | Process/container lifecycle and restart |
| Queueing, interruption, approvals, retries                    | Ingress, TLS, DNS, tunnels              |
| Sessions, automations, schedules, team routing                | Secret injection                        |
| Vivid product schema, Flue database path, and artifact layout | A durable mounted directory             |
| Tool, browser, and computer protocols                         | Optional snapshots/backups              |
| Authorization policy and audit events                         | Metrics/log shipping                    |

Model APIs and SaaS connectors can still be network dependencies. “Cloud-independent” means changing the machine, storage, or ingress provider does not change the agent runtime or its state model.

## Do not collapse the runtime layers

The model SDK, agent harness, durable runtime, and execution host are separate choices:

| Layer                  | Responsibility                                                                                 | Examples                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Model/provider adapter | Calls models and normalizes streaming/tool-call formats                                        | provider SDKs, Vercel AI SDK, `pi-ai`             |
| Agent harness          | Runs the model/tool loop and manages context                                                   | Pi, AI SDK's tool loop                            |
| Durable runtime        | Admits work, journals state, enforces one owner, resumes after failure, and reconnects streams | Think, Flue runtime, OpenSession's session kernel |
| Execution host         | Supplies process lifetime, storage, timers, filesystem, browser, and subprocesses              | Node/Linux, Durable Objects, a VM/container       |
| Product                | Defines permissions, memory, teammates, schedules, and UI semantics                            | Vivid                                             |

A framework may bundle several rows, but the rows still exist. Vercel AI SDK is not by itself a durable runtime. Pi is an agent harness, not by itself a crash-recovery system. Effect is useful for typed services, resources, concurrency, and failure handling inside Vivid; it does not replace a persisted journal, ownership protocol, or recovery state machine.

Cloudflare **Think** and Astro's **Flue** make different bundles:

- Think uses the Vercel AI SDK loop and puts persistence, resumable streams, recovery fibers, scheduling, and ownership on Cloudflare Agents/Durable Objects. Its guarantees therefore select the Cloudflare host as well as the framework. [Think overview](https://github.com/cloudflare/agents/blob/main/docs/think/index.md), [recovery](https://developers.cloudflare.com/agents/harnesses/think/recovery/)
- Flue explicitly builds on Pi and adds its own conversation journal, submissions, step records, recovery, streaming, and target adapters. The same application model can target a normal Node process or Durable Objects. [Why Flue](https://flueframework.com/docs/guide/why-flue/), [Node target](https://flueframework.com/docs/guide/node-target/)
- The local Cloudflare OS source does not use Think. Its workshop agent imports `runAgentLoopContinue` from `@earendil-works/pi-agent-core`, so it is another Pi-based stack with its own Cloudflare-native persistence and orchestration.

For Vivid, the decision is Flue's portable durable envelope rather than building a custom one around
Pi. Think remains valuable reference material, but choosing it as the foundation would also choose
Durable Objects as the canonical host.

## What the references actually show

### Cloudflare OS

Cloudflare OS validates capability-based resource access, isolated user-created software, and asynchronous review as product ideas. Its execution topology is deliberately Cloudflare-native: every workspace is a Durable Object, every Gadget runs in a Dynamic Worker Facet, and Gatekeepers are separate Workers/facets. Its local command runs the whole stack through Wrangler/workerd, but the README says that mode is not for production; production self-hosting on workerd is still marked “coming soon.” [Official source](https://github.com/cloudflare/cloudflare-os/blob/main/README.md#built-on-workers-by-the-workers-team), [self-hosting status](https://github.com/cloudflare/cloudflare-os/blob/main/README.md#deploy-to-your-own-server-using-workerd)

**Meaning for Vivid:** borrow Gatekeepers’ capability/audit model. Do not borrow the deployment graph. Open-source workerd makes that graph self-hostable, not portable to an ordinary process model.

Workers also remain a constrained host for whole-machine work. The runtime has CPU and memory limits, and its Node APIs are a compatibility subset. Its filesystem exposes a read-only bundle and memory-backed temporary storage. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [filesystem API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)

Cloudflare Containers can run arbitrary Linux software, but each container is still addressed through a Worker and Durable Object, and local disk is ephemeral when an instance sleeps. Durable files require an external store or mounted object storage. [Containers](https://developers.cloudflare.com/containers/), [FAQ](https://developers.cloudflare.com/containers/faq/), [Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/), [persistent storage](https://developers.cloudflare.com/sandbox/tutorials/persistent-storage/)

**Verdict:** viable later as a hosting adapter; wrong as Vivid’s defining abstraction.

### Flue

Flue is the clearest public precedent for a framework supporting both shapes. Its Node target builds a self-starting `dist/server.mjs` that owns HTTP, agent dispatch, and durable conversation streaming and runs wherever Node runs. On Node, `local()` uses the real host filesystem and `child_process`. File-backed SQLite or another database adapter supplies persistence. [Node target](https://flueframework.com/docs/guide/node-target/), [database](https://flueframework.com/docs/guide/database/), [durability](https://flueframework.com/docs/guide/durability/)

Its Cloudflare target instead generates a Durable Object class and binding for each agent and uses Cloudflare-specific primitives. [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)

**Meaning for Vivid:** target the Flue Node shape: a normal server with real host abilities and replaceable persistence. Keep it behind Vivid’s product and executor interfaces so Flue owns agent semantics without defining users, teams, permissions, artifacts, or the UI.

### Correction: SQLite stores durability; it does not execute it

The earlier wording risked treating “uses SQLite” as the durability mechanism. SQLite only preserves the facts needed to recover. A scheduler, wakeup source, ownership protocol, and recovery state machine still have to interpret those facts and run code.

| Runtime            | Durable state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | What actually schedules, resumes, and retries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Restart boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flue 2.0.3 on Node | File-backed SQLite stores the submission ledger and ordering, attempts/leases/abort/settlement, the append-only canonical conversation stream including partial responses and tool records, persisted hook state, attachments, and oversized payload chunks. [execution store](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/sql-agent-execution-store.ts), [conversation store](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/runtime/conversation-stream-store.ts), [attachments](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/sql-attachment-store.ts)                                                                                                                                          | The process-local `AgentCoordinator` claims runnable rows, heartbeats leases, scans expired work, and drives attempts. On boot, `reconcileSubmissions()` classifies interrupted rows and either settles from canonical evidence, requeues, continues partial output, or records an unknown tool outcome. SQLite supplies atomic persistence/CAS; the coordinator and reconciliation policy are the engine. [coordinator](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/node/agent-coordinator.ts), [reconciliation](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/runtime/agent-submissions.ts)                                                                                                                                                                                                   | Durable rows survive a process restart only when `sqlite(path)` is given a file; the default is `:memory:`. In-flight promises, timers, model connections, and live MCP connections do not survive. Nothing wakes while the Node process is down; boot reconciliation resumes owed work. [Node SQLite adapter](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/node/agent-execution-store.ts), [startup assembly](https://github.com/withastro/flue/blob/832ad2eeaf5e4b07d39749fc669e7ad556238313/packages/runtime/src/node/assemble.ts) |
| Cloudflare Think   | Per-agent Durable Object SQL stores the transcript, resumable stream metadata/chunks, submissions and idempotency/status, scheduled jobs, fiber checkpoints, tool/subagent projections, action approvals, and declared schedules. Some recovery incidents and application context are Durable Object KV keys rather than SQL rows. The app's `WorkspaceAgent` owns a separate SQL-backed VFS; its sync-retry intents are KV, not ThinkAgent rows. [stream store](https://github.com/cloudflare/agents/blob/main/packages/agents/src/chat/resumable-stream.ts), [Think tables and submission drain](https://github.com/cloudflare/agents/blob/main/packages/think/src/think.ts), [Agent tables](https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts), [local app ownership](~/work/vcos-lanes/upstream-agents/agent-think/src/workspace-agent.ts) | `submitMessages()` persists a pending row and schedules `_drainThinkSubmissions`. The Agents lifecycle stores a job row, arms the physical Durable Object alarm for the next due job, and its alarm driver dispatches with retry/deferral policy. Think's `ChatRecoveryEngine` then decides bounded retry versus continuation of partial output. Cloudflare's alarm delivery plus Agents/Think code is the engine; SQLite is its evidence store. [job queue](https://github.com/cloudflare/agents/blob/main/packages/agents/src/lifecycle/job-queue.ts), [alarm lifecycle](https://github.com/cloudflare/agents/blob/main/packages/agents/src/lifecycle/durable-object-lifecycle.ts), [alarm driver](https://github.com/cloudflare/agents/blob/main/packages/agents/src/lifecycle/job-driver.ts), [recovery engine](https://github.com/cloudflare/agents/blob/main/packages/agents/src/chat/recovery-engine.ts) | Durable Object SQL/KV, alarms, transcript/stream chunks, submissions, fiber snapshots, approvals, schedules, and `/workspace` VFS survive isolate eviction or deployment. JavaScript stacks, active model/network streams, cached stubs/tokens, container processes, and `/temp` do not; recovery reconstructs work and reauthenticates. [agent-think recovery wiring](~/work/vcos-lanes/upstream-agents/agent-think/src/agent.ts), [workspace recovery test](~/work/vcos-lanes/upstream-agents/agent-think/tests-e2e/flow.test.ts)                                                           |

So copying Think's SQLite schema into a Node app would **not** reproduce Think. Its guarantees also depend on Durable Object alarm delivery and the Agents/Think lifecycle code. Conversely, Flue already includes a Node recovery engine above SQLite, but only recovers when the daemon starts again. For either architecture, the right question is not “does it use SQLite?” but “who wakes, claims, fences, retries, and reconciles persisted work?”

## Flue 2.0.3: fit, gaps, and the AI SDK boundary

The default should now be **try Flue before building a runtime around Pi ourselves**. Flue 2.0.3 already owns the parts that would otherwise force Vivid down to OpenSession's level: the Pi loop, canonical conversation log, durable admission queue, leases and restart reconciliation on Node, partial-stream recovery, compaction, durable tool steps, resumable subagents, and a reconnecting client protocol. The remaining gaps are mostly Vivid product responsibilities. They are reasons to keep a narrow boundary around Flue, not reasons to reject it. [2.0.3 changelog](https://github.com/withastro/flue/blob/main/CHANGELOG.md#203---2026-08-04), [durability](https://flueframework.com/docs/guide/durability/)

### What Flue already gives us

| Area              | Published Flue 2.0.3 behavior                                                                                                                                                                                                                                                                                                                               | Consequence for Vivid                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable turns     | Input is persisted before execution; each accepted submission must settle completed, failed, or aborted. Recovery preserves partial output, repairs tool batches conservatively, retries transient provider errors, and prevents one interrupted submission from wedging the queue. [Durability](https://flueframework.com/docs/guide/durability/)          | Do not rebuild the conversation journal, retry classifier, or recovery loop first.                                                                                                                  |
| Node self-hosting | Vite builds a normal `dist/server.mjs`; file-backed SQLite persists one-machine installations; `local()` exposes the real filesystem and child processes. [Node target](https://flueframework.com/docs/guide/node-target/)                                                                                                                                  | Fits the one-program laptop/container/VM requirement without selecting Cloudflare.                                                                                                                  |
| Streaming         | The public protocol has durable offsets, snapshots, SSE and long-polling, reconnection, reset recovery, and duplicate suppression. [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/), [Agent SDK](https://flueframework.com/docs/sdk/overview/)                                                                            | This is stronger than raw AI SDK stream resumption and should remain the canonical transport.                                                                                                       |
| React client      | `useFlueAgent()` supplies optimistic sends, durable-history hydration, message status, reconnects, settlements, text/reasoning/tool/file parts, response metadata, and named structured data parts. [React](https://flueframework.com/docs/guide/react/), [agent hooks](https://flueframework.com/docs/guide/agent-hooks/#streaming-data-to-the-client)     | Use `@flue/sdk`/`observe()` under a framework-neutral Vivid store if Flue is the runtime. AI Elements can remain view components, but `useChat` must not become a second owner of the conversation. |
| Tools and MCP     | Typed tools, conditional tools, durable `step.do`, host or remote sandboxes, MCP discovery/auth/allowlists, and structured tool output are built in. [Tools](https://flueframework.com/docs/guide/tools/), [MCP](https://flueframework.com/docs/guide/mcp/)                                                                                                 | Connectors and computer operations can enter through one tool boundary.                                                                                                                             |
| Subagents         | Pi-backed child sessions have fresh context, parallel execution, nested delegation, their own durable transcript, and crash recovery that reattaches the parent to the child. [Subagents](https://flueframework.com/docs/guide/subagents/), [delegated-task recovery](https://flueframework.com/docs/guide/durability/#delegated-tasks)                     | Use this for bounded delegated work. Persistent Vivid teammates remain registered top-level agents.                                                                                                 |
| Models            | Pi supplies the major provider catalog, reasoning controls, usage/cost metadata, compaction, images, and custom OpenAI/Anthropic-compatible providers. Structured results are available inside `harness.prompt()`. [Models](https://flueframework.com/docs/guide/models/), [Harness API](https://flueframework.com/docs/reference/agent-api/#harnessprompt) | We do not need AI SDK for the primary text/tool loop or provider portability.                                                                                                                       |
| Observability     | Typed runtime events cover turns, tools, tasks, compaction, logs, usage, cost, and terminal settlement, with Sentry, Braintrust, and OpenTelemetry integrations. [Observability](https://flueframework.com/docs/guide/observability/)                                                                                                                       | Enough for engineering telemetry; Vivid still needs a durable user-facing activity/audit model.                                                                                                     |

### The actual gaps

| Gap                             | Exact boundary                                                                                                                                                                                                                                                                                                                                                                                                           | What Vivid should own                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable human approval          | Flue has no first-class pending-approval record, approval tool-part states, `approve`/`reject` API, browser-executed tool result path, or durable pause that resumes the same call. Its approval example records an approval code as a later tool/message; that is application convention, not a suspended execution. [Tools example](https://flueframework.com/docs/guide/tools/#conditional-tools)                     | A small approval ledger and policy layer: request, risk/summary, approvers, decision, expiry, audit, and continuation. This is the first framework gap to spike. Do not keep a promise open while waiting. |
| Arbitrary waits and workflows   | Flue checkpoints the agent and `durable: true` tool steps, not arbitrary TypeScript around the agent. Version 2 removed its workflow engine and explicitly delegates multi-step orchestration, long waits, and external events to another workflow system. [Workflows](https://flueframework.com/docs/guide/workflows/), [durability boundary](https://flueframework.com/docs/guide/durability/#code-outside-the-agent)  | For conversational waits, settle and accept a later signal as a new submission. Add a small Vivid job state machine only when a product flow must resume at an exact program counter.                      |
| Scheduling product              | Flue explicitly has no scheduler. Node examples use an in-process cron library, which misses fires during downtime and runs in every replica. [Schedules](https://flueframework.com/docs/guide/schedules/)                                                                                                                                                                                                               | Persisted schedules, one-shot timers, timezone/DST policy, catch-up, ownership, CRUD, and visible run history. A schedule ultimately calls Flue `dispatch()`.                                              |
| Users, teams, permissions       | Mounted agents have no built-in authentication or ownership check. Conversation ids are caller-chosen. [Routing and auth](https://flueframework.com/docs/guide/routing/#protecting-your-agents)                                                                                                                                                                                                                          | Organizations, memberships, teammate ownership, authorization, capability grants, secrets, and audit. This belongs above any agent framework.                                                              |
| Conversation/product index      | A Flue client addresses one known conversation URL. There is no deployment-wide client, conversation enumeration, lookup, deletion, per-user read state, or retention API. [SDK conversation model](https://flueframework.com/docs/sdk/overview/#one-conversation-per-client)                                                                                                                                            | Vivid's thread, teammate, activity, and attention-state tables and APIs, referencing the Flue conversation id and incarnation uid.                                                                         |
| Multi-replica ownership         | Shared storage permits replacement recovery but not concurrent owners or round-robin requests for one conversation. [Node state and durability](https://flueframework.com/docs/guide/node-target/#state-and-durability)                                                                                                                                                                                                  | Keep one Vivid runtime owner initially. Later add sticky placement and fencing if multi-node demand earns it.                                                                                              |
| Computer lifecycle              | A sandbox adapter presents filesystem and command operations; Flue does not provision/supervise Vivid's browser, desktop, VNC stream, container, or remote machine lifecycle. Sandbox files are deliberately separate from conversation durability. [Sandboxes](https://flueframework.com/docs/guide/sandboxes/), [workspace durability](https://flueframework.com/docs/guide/durability/#keep-workspace-state-separate) | A Vivid computer adapter and supervisor keyed by teammate/runtime identity. Feed its operations to Flue as tools.                                                                                          |
| Tool-produced vision            | User-message image attachments work, but current custom-tool output is serialized as text rather than returned to the parent model as native image content. That blocks the natural screenshot -> same agent vision loop. [Flue discussion #565](https://github.com/withastro/flue/discussions/565)                                                                                                                      | Treat this as a runtime acceptance gate. First try a public adapter/patch; a second nested model call is only a temporary workaround because it adds cost and loses the parent's full context.             |
| Files and artifacts             | Delivered attachments are images only, base64, capped at 14 MiB. The attachment store preserves those immutable inputs; large tool artifacts are expected to live in the sandbox behind a pointer. [Delivered messages](https://flueframework.com/docs/reference/agent-api/#deliveredmessage), [tool durability limits](https://flueframework.com/docs/guide/tools/#durable-tools)                                       | General files, generated artifacts, previews, versions, provenance, sharing, and lifecycle. Store artifact references in Vivid data parts.                                                                 |
| Durable operational history     | Runtime observability is isolate/process scoped and live-only; the user conversation is durable, but a fleet-wide operational event log is not. [Observability](https://flueframework.com/docs/guide/observability/#subscribing-with-observe)                                                                                                                                                                            | Persist the small subset needed for activity, billing, security audit, and support. Export the rest as telemetry.                                                                                          |
| Product interaction affordances | `@flue/react` is a state hook, not a component library. It lacks built-in approval cards, artifacts, citations, branching/regeneration controls, voice, file tree, terminal, and computer-view components.                                                                                                                                                                                                               | Build Vivid's product UI from reusable visual components rather than replacing the runtime.                                                                                                                |

There are also two durability limits no framework can hide. An interrupted ordinary side-effecting tool becomes an unknown outcome rather than being blindly rerun. A `step.do` result is exactly-once recorded but the underlying function is at-least-once executed, so external APIs still need idempotency keys. [Durable tools](https://flueframework.com/docs/guide/durability/#durable-tools-and-stepdo)

### Source audit correction: AI SDK UI is not Vivid's canonical client runtime

The earlier adapter sketch understated the mismatch. This audit compared Flue 2.0.3 with AI SDK `ai` 7.0.90 and `@ai-sdk/react` 4.0.93 at source level. [Audited Flue revision](https://github.com/withastro/flue/tree/832ad2eeaf5e4b07d39749fc669e7ad556238313), [audited AI SDK revision](https://github.com/vercel/ai/tree/622fa7f0488c7bee024f63691963d43fb9592cec)

An AI SDK `ChatTransport` has only two operations: `sendMessages()` returns a stream of `UIMessageChunk`s for one submit/regenerate request, and `reconnectToStream()` returns the continuation of one active response. `Chat` then owns a second local message array, one active-response reducer, and request-local `submitted | streaming | ready | error` status. Its `stop()` aborts the browser request; its edit, regenerate, approval, and client-tool methods first mutate that local array. [ChatTransport source](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts), [Chat source](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat.ts), [`useChat` source](https://github.com/vercel/ai/blob/main/packages/react/src/use-chat.ts)

Flue exposes a different contract. `observe()` maintains the complete canonical conversation from a durable snapshot plus ordered updates, rehydrates on reconnect/reset, deduplicates replayed chunks, and includes submissions and settlements. Its raw projection chunks are explicitly not stable application API. Flue messages also carry dispatch/advisory lanes, display policy, turn/submission identity, and durable settlement state. [Flue client source](https://github.com/withastro/flue/blob/main/packages/sdk/src/client.ts), [observation source](https://github.com/withastro/flue/blob/main/packages/sdk/src/public/observe.ts), [conversation source](https://github.com/withastro/flue/blob/main/packages/sdk/src/public/conversation.ts), [projection source](https://github.com/withastro/flue/blob/main/packages/sdk/src/public/conversation-stream.ts)

Ratings below mean:

- **Works directly:** no chat-state adapter is needed.
- **Thin mapping:** a small, faithful conversion exists for the stated subset.
- **Semantic mismatch/lost:** it can be made to look right, but drops or changes behavior.
- **Impossible/public API gap:** the required server operation or stable transport primitive does not exist; adding it means a Vivid protocol/runtime feature, not a transport mapper.

| Capability                                                     | Rating                                                            | Source-level result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submit one text prompt                                         | **Thin mapping**                                                  | `sendMessages()` can select the newly appended user part and call Flue `send({ kind: 'user' })`. Flue does not accept the full AI SDK message array. [Flue send source](https://github.com/withastro/flue/blob/main/packages/sdk/src/public/send.ts)                                                                                                                                                                                                                                                                                                                                                                                      |
| Stream the submitting client's text/reasoning reply            | **Thin mapping**                                                  | Flue materializes streaming text/reasoning and completed dynamic tools. A bridge can diff the observed assistant message into AI chunks, but public `observe()` yields state, not stable raw deltas, so the bridge must perform that diff itself.                                                                                                                                                                                                                                                                                                                                                                                         |
| Canonical transcript hydration and reset                       | **Impossible through `ChatTransport` alone**                      | Flue can replace the entire materialized state after snapshot catch-up or incarnation reset. AI's stream reducer builds or updates one assistant message and has no full-conversation snapshot/reset chunk. Initial `messages` plus later `setMessages()` is a second synchronization path and reducer. [AI stream reducer](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/process-ui-message-stream.ts), [AI chunk union](https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts), [Flue streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)             |
| Reconnect one active reply                                     | **Semantic mismatch/lost**                                        | A bridge can replay the current assistant message then follow it, but AI reconnect resumes one response while Flue reconnect rehydrates the whole conversation at a durable offset. Queue/coalescing, settlement, reset, and unrelated messages still need a side channel. AI's stock resumable-stream recipe does not change this message-model mismatch. [AI stream resumption](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)                                                                                                                                                                                               |
| Other devices, webhooks, schedules, dispatch/advisory messages | **Impossible through normal `useChat` flow**                      | Flue may append or revise multiple messages independently of the active browser request. `useChat` consumes only the response stream it started or explicitly resumed; representing continuous canonical observation requires `observe()` plus external `setMessages()`, duplicating ownership.                                                                                                                                                                                                                                                                                                                                           |
| Multiple queued or coalesced submissions                       | **Semantic mismatch/lost**                                        | AI `Chat` models one active response and request status. Flue queues concurrent submissions and can settle one as answered by another submission. That attribution has no `UIMessageChunk` or `useChat` status equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Typed tool parts and `InferAgentUIMessage`                     | **Impossible/public type gap**                                    | AI infers static `tool-${name}` parts from an AI SDK `Agent`. Flue exposes only `dynamic-tool` with `input` and `output` as `unknown`; a Flue agent is not an AI SDK agent. Vivid could maintain a manual tool registry and validators, but it would not be end-to-end `InferAgentUIMessage` inference. [AI inference source](https://github.com/vercel/ai/blob/main/packages/ai/src/agent/infer-agent-ui-message.ts), [AI `UIMessage` source](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/ui-messages.ts), [Flue conversation source](https://github.com/withastro/flue/blob/main/packages/sdk/src/public/conversation.ts) |
| Server tool display                                            | **Thin mapping with loss**                                        | Completed Flue calls map to AI dynamic-tool input/output/error parts. Flue does not publish tool-input token streaming, provider-executed flags/metadata, titles, preliminary results, approval states, or denied output.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Durable tool approval                                          | **Impossible/public API gap**                                     | AI has approval-request/response chunks and local `addToolApprovalResponse()`. Flue has no pending-approval part, decision endpoint, or suspended continuation. Resubmitting AI's locally mutated transcript cannot modify Flue's canonical transcript or resume the original call.                                                                                                                                                                                                                                                                                                                                                       |
| `addToolOutput()` and browser/client tools                     | **Impossible/public API gap**                                     | AI locally inserts a tool result and may submit again. Flue `send()` accepts a user message or string-valued signal, not a tool-call result tied to an outstanding invocation; server tools execute inside Flue. This needs a Vivid continuation/result protocol.                                                                                                                                                                                                                                                                                                                                                                         |
| `stop()`                                                       | **Semantic mismatch/lost**                                        | AI `stop()` aborts local file preparation and the active fetch/stream. Flue intentionally continues admitted work when observation disconnects. Flue `abort()` is separate and aborts **all** running and queued work for the conversation, not merely this UI response. Wiring an `AbortSignal` to `abort()` would silently broaden cancellation. [Flue client source](https://github.com/withastro/flue/blob/main/packages/sdk/src/client.ts), [Flue React source](https://github.com/withastro/flue/blob/main/packages/react/src/use-agent.ts)                                                                                         |
| Regenerate                                                     | **Impossible/public API gap**                                     | AI truncates its local messages and sends a `regenerate-message` trigger. Flue is an append-only canonical conversation and exposes no regenerate/branch operation. A local-only regeneration would disagree with durable history.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Edit an earlier user message                                   | **Impossible/public API gap**                                     | AI locally replaces that user message and deletes everything after it. Flue has no transcript rewrite or branch-from-message API. Vivid must define branch/replay semantics explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Image attachment input                                         | **Thin mapping**                                                  | AI file parts can become Flue image attachments when their media types and bytes are available. Flue input attachments are image-only, base64, and capped at 14 MiB. [Delivered message API](https://flueframework.com/docs/reference/agent-api/#deliveredmessage)                                                                                                                                                                                                                                                                                                                                                                        |
| General files, sources, reasoning files, provider/custom parts | **Semantic mismatch/lost**                                        | AI has generic file, source URL/document, reasoning-file, custom-provider, and provider-metadata parts. Flue's stable public projection has an attachment file part but no equivalent source/reasoning-file/provider-content variants. Preserve these as Vivid artifact/data records rather than pretending they round-trip. [AI `UIMessage` source](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/ui-messages.ts)                                                                                                                                                                                                            |
| Named structured data                                          | **Thin mapping with limits**                                      | Both use `data-${name}` parts and update a named part in place. AI additionally supports typed schemas, ids, and transient chunks; Flue's public client payload is `unknown` and durable, so Vivid supplies validation/types and cannot reproduce transient semantics from history. [Flue data writer](https://flueframework.com/docs/guide/agent-hooks/#streaming-data-to-the-client)                                                                                                                                                                                                                                                    |
| Error, status, settlement                                      | **Semantic mismatch/lost**                                        | AI status describes one local request. Flue distinguishes admission failure, observation health, and durable per-submission completed/failed/aborted settlement. Flattening these into `useChat.status` loses product-critical truth.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Usage, model, finish metadata                                  | **Thin mapping by convention**                                    | AI chunks have finish reason and message/provider metadata. Flue message metadata is entirely agent-authored; Vivid can stamp usage/model in response hooks, but the runtime does not guarantee them in every projected message. Flue settlement also has no AI finish-reason equivalent.                                                                                                                                                                                                                                                                                                                                                 |
| Web and Electron                                               | **Works directly for Flue SDK; mapping needed for AI components** | Use `@flue/sdk` or a Vivid store over it as the canonical state source. Convert Flue parts to view props or a Vivid message view model; do not put `useChat` between the UI and Flue.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| React Native / Expo                                            | **Flue support gap; AI SDK works directly**                       | AI SDK officially documents `useChat` on Expo 52+ with `expo/fetch`, including streamed tools; Flue has no first-party React Native client guide. A Flue-based Vivid client store is plausible over fetch/long-poll, but it is another adapter Vivid must own and test. [AI SDK Expo guide](https://ai-sdk.dev/docs/getting-started/expo), [Flue SDK overview](https://flueframework.com/docs/sdk/overview/)                                                                                                                                                                                                                              |
| AI Elements components                                         | **Works directly as presentation**                                | Keep the copied/source-owned message, prompt, tool-card, reasoning, and artifact components. Adapt their props to Vivid's view model. AI Elements does not require `useChat` to own canonical chat state. [AI Elements](https://github.com/vercel/ai-elements)                                                                                                                                                                                                                                                                                                                                                                            |
| AI SDK Core beside Flue                                        | **Works directly**                                                | Continue using independent generation APIs where useful—embeddings, reranking, image/video, transcription, and speech—without running an AI SDK text-agent loop for the Flue-owned conversation. [AI SDK Core](https://ai-sdk.dev/docs/reference/ai-sdk-core)                                                                                                                                                                                                                                                                                                                                                                             |

**Decision:** do not make `useChat` the main Vivid client runtime. The honest adapter is either a lossy single-submit projection or a rebuild of Flue's observation reducer, snapshot recovery, settlement model, multi-writer synchronization, and control plane. Use Flue's `observe()` as the canonical source, wrap it in a small framework-neutral Vivid client store, and map that store into AI Elements or other presentation components.

The small adapter that remains worthwhile is a **view adapter**, not a `ChatTransport`:

```text
Flue observe() + Vivid approvals/artifacts/activity
        -> Vivid client store and view model
        -> web / Electron / mobile presenters
        -> AI Elements components where useful
```

Approval, client-tool output, per-submission cancellation, branch/regenerate, and edit are Vivid protocol additions. They should be designed against Flue's durable identities and settlement rules instead of simulated inside AI SDK local state.

### Rejected AI-native alternatives: WorkflowAgent or Harness Pi

If Vivid does not specifically need Pi, the shortest path to the complete AI SDK contract is AI SDK 7's `WorkflowAgent`, not a Flue bridge and not necessarily a harness. It keeps the normal AI SDK tool loop and tool definitions, adds durable workflow steps and approvals, and has a native `WorkflowChatTransport` for `useChat` reconnection. That preserves typed UI parts, client tools, approval states, sources/files, edit/regenerate triggers, and the rest of the AI SDK UI protocol instead of translating them after the fact. [WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent), [WorkflowChatTransport](https://ai-sdk.dev/docs/reference/ai-sdk-ui/workflow-chat-transport)

The tradeoff moves to hosting. `WorkflowAgent` currently requires Workflow 5 beta. The local World persists data to disk but keeps its queue in memory and is explicitly for development/testing; the documented self-hosted production World uses Postgres and Graphile Worker. This is portable and cloud-independent, but not the desired SQLite-only single-directory production shape. [Local World](https://workflow-sdk.dev/worlds/local), [Postgres World](https://workflow-sdk.dev/worlds/postgres)

There is therefore no currently verified option that gives all three at once:

1. the complete native AI SDK `useChat`/tool/UI contract;
2. crash-safe admission, waits, approvals, and recovery;
3. production-grade embedded SQLite with no external service.

Flue gives 2 + 3 but only a lossy projection of 1. `WorkflowAgent` with the Postgres World gives 1 + 2 but not 3. The Workflow Local World gives 1 + a local developer experience, not crash-safe production admission. Vivid chooses Flue because the self-contained runtime and canonical multi-client conversation are foundational; native `useChat` compatibility is not worth replacing those properties.

The current AI SDK has a materially different option from putting `useChat` on top of Flue. Its experimental Harness API wraps established runtimes behind `HarnessAgent`; `@ai-sdk/harness-pi` 1.0.101 runs Pi in the host Node process and exposes AI SDK tools, skills, MCP configuration, typed built-in tools, built-in permission requests, host-tool approval, resumable sessions, and AI-native UI streams. The official UI path is therefore genuinely `HarnessAgent -> UIMessageStream -> useChat`, with no Flue message bridge. [Harness overview](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/01-overview.mdx), [Pi adapter](https://github.com/vercel/ai/blob/main/content/providers/02-ai-sdk-harnesses/03-pi.mdx), [tools and approvals](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/03-tools.mdx), [Harness UI](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/07-ui.mdx), [package source](https://github.com/vercel/ai/tree/main/packages/harness-pi)

`@ai-sdk/workflow-harness` 1.0.99 adds a serializable state machine for running a Harness turn as durable Workflow DevKit steps. It can checkpoint after each semantic agent step or a time slice, carries a suspended continuation across processes, and has an explicit `awaiting_tool_approval` state. This fixes several exact Flue gaps while preserving native AI UI semantics. It does **not** supply a complete Vivid product store: the application must still persist per-chat harness `resumeFrom` state between workflow runs, UI messages, users/teams, artifacts, schedules, audit, and multi-device synchronization. [Workflow harness guide](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/06-workflow-utilities.mdx), [durable state source](https://github.com/vercel/ai/blob/main/packages/workflow-harness/src/harness-workflow-state.ts), [runner source](https://github.com/vercel/ai/blob/main/packages/workflow-harness/src/run-harness-agent.ts), [package source](https://github.com/vercel/ai/tree/main/packages/workflow-harness)

| Decision area                                   | Flue 2.0.3                                                                                  | AI SDK Harness Pi + Workflow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI SDK UI, typed tools, approvals, client tools | Bridge is lossy; approvals/client tools require Vivid runtime additions                     | Native UI streams and approval continuation; type UI tools from `agent.tools` rather than `InferAgentUIMessage` for now                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent runtime                                   | Pi loop integrated with Flue durability, subagents, tools, MCP, compaction                  | Pi runs in the host Node process behind `HarnessAgent`; AI SDK supplies tools, skills, MCP, permission modes, session continuation                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Turn durability                                 | Built-in Node SQLite journal, admission queue, leases, partial-output recovery, settlements | Workflow steps persist serialized continuation and output; durability depends on the selected Workflow World                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Local self-contained shape                      | Normal Node server plus file-backed SQLite                                                  | Host Pi can be local, but Workflow Local World is documented for development/testing and uses filesystem data plus in-memory queuing                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Production self-hosting                         | Node server and replaceable database adapter                                                | Workflow recommends Vercel for managed production. Its self-host example selects `@workflow/world-postgres`; that package is a Postgres/Graphile embedded reference implementation and notes that production may split workers or use a dedicated queue. [Workflow deployment](https://github.com/vercel/workflow/blob/main/docs/content/docs/v5/deploying.mdx), [Local World](https://github.com/vercel/workflow/blob/main/packages/world-local/README.md), [Postgres World](https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md) |
| Canonical conversation and multiple writers     | Durable full-conversation snapshot/observe protocol is built in                             | Harness owns native history and opaque resume state; app still owns durable UI history and continuous multi-client synchronization                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API maturity                                    | Young but its durability path is the framework's core                                       | Harness packages are explicitly **experimental** and warn of breaking changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Decision:** these are competing runtime cores, not layers to stack. Flue Node is selected because one-program Node + SQLite recovery and canonical multi-client conversation truth are non-negotiable. `WorkflowAgent` and Harness Pi + Workflow remain documented alternatives, not active dependencies or parallel runtimes. Both Workflow paths currently require accepting Postgres or another production World and testing current reconnect/control sharp edges. [Open `WorkflowChatTransport` lifecycle issue](https://github.com/vercel/ai/issues/14617)

Do not build a Flue-to-`useChat` bridge or a second runtime prototype. Validate Flue directly with one restartable tool turn, one Vivid-owned approval that survives process restart, one reconnect from a second device, and one self-hosted production-style run. Reopen the runtime decision only if a required capability cannot be implemented through Flue's public contracts.

Think shows the fully integrated version of those semantics: it layers AI SDK tools/UI messages onto Durable Objects and adds actions with an idempotency ledger, authorization, inline approvals, and durable approval pauses. That is the behavior to copy or pressure-test against, but the implementation selects Cloudflare. [Think actions](https://github.com/cloudflare/agents/blob/main/docs/think/actions.md), [Think client tools](https://developers.cloudflare.com/agents/harnesses/think/client-tools/)

### Connectors under the hood

Flue supplies useful edges, not Vivid's connector system:

- MCP mounting discovers tools, applies allowlists, and can resolve authentication dynamically, but Flue deliberately does not own OAuth installation, token storage, refresh, revocation, account ownership, or permissions. [MCP](https://flueframework.com/docs/guide/mcp/)
- Channel packages verify inbound webhooks and normalize delivery into an agent submission. The application still selects the account and conversation, deduplicates events, stores installations, and makes outbound provider calls. [Channels](https://flueframework.com/docs/guide/channels/)
- A model-facing tool is not the security boundary. It describes an operation; Vivid decides whether it may happen and the executor performs it.

Keep this inside the one Vivid installation, but separate the responsibilities:

```text
provider webhook / scheduled sync
        -> event inbox (verify + dedupe)
        -> Vivid routing (org, teammate, thread)
        -> Flue submission
        -> proposed connector/computer tool call
        -> policy + approval
        -> executor (stable operation id)
        -> provider or computer
        -> receipt + audit + Flue tool result
```

The minimum connector domain is below. Its **event inbox is an internal durable-ingestion pattern**, not evidence for or a decision to add an Inbox screen to Vivid.

| Part                 | Responsibility                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Connector definition | Provider capabilities, scopes, triggers, and typed operations                                  |
| Connected account    | User/org ownership and installation state                                                      |
| Credential broker    | Encrypted tokens, refresh, revocation, and secret access; models never receive raw credentials |
| Adapter              | Narrow typed reads/actions and normalized inbound events                                       |
| Event inbox          | Webhook verification, polling cursors, deduplication, replay, and dispatch idempotency         |
| Policy/approval      | Who may request, approve, or automatically run an operation                                    |
| Executor             | Runs computer and connector side effects outside the agent loop                                |
| Receipt/audit        | Records request, policy decision, provider operation id, outcome, and reconciliation state     |

Use the likely executor for connector writes as well as browser, shell, and computer actions. It need not be a separately deployed service: it can be a supervised child process behind an internal protocol. A Flue tool should be a thin caller. Give every executor request a stable operation id derived from the tool call and durable-step identity; let the executor persist the receipt and reconcile unknown outcomes. Flue's `step.do` then records the conversation-side result, while the executor remains authoritative about whether the external side effect happened.

MCP remains an adapter option for tool discovery. It must not become the credential vault, authorization model, account database, or audit log.

### Flue acceptance gate

Implement against Flue's public Node runtime and prove these cases in order:

1. kill and restart the Node process during streamed text, an ordinary tool, a durable tool, and a subagent;
2. disconnect and reconnect two clients without missing or duplicating durable conversation state;
3. request approval, restart while pending, decide from another client, and continue exactly once using the smallest Vivid-owned approval overlay;
4. persist a schedule, miss its fire during downtime, restart, and catch it up once;
5. keep the same teammate conversation and workspace across a local process and a container restart.
6. start work on desktop, disconnect it, reconnect from phone, approve or interrupt once, and continue without losing or duplicating events.

If approval, tool-produced vision, per-submission control, or Vivid's client model requires patching Flue's private journal or coordinator, record the blocker and reopen the architecture decision. Do not keep a dormant second runtime in the codebase.

### celld

celld is a single Rust daemon and OCI image that embeds V8 and runs a Workers/Durable Objects application across machines. A cell has SQLite state, while deployments, state, and leases replicate through a supported object-store bucket. The bucket is the fleet coordinator rather than a separate control plane. [Official README](https://github.com/denoland/celld/blob/89e4ffc53a14ecb496d2ca5014ff9d19b0061ad9/README.md), [fencing design](https://github.com/denoland/celld/blob/89e4ffc53a14ecb496d2ca5014ff9d19b0061ad9/docs/fencing.md)

It is one program operationally, but it still preserves the Workers programming model. Normal
fleet operation requires a supported object-store bucket, including on a laptop; there is no plain
local-filesystem mode. Its compatibility documentation says `node:fs`, child processes, worker
threads, VM APIs, and raw networking are absent or stubbed, and browser rendering is not supported.
[Cloudflare compatibility](https://celld.dev/docs/cloudflare-compat/), [limitations](https://github.com/denoland/celld/blob/89e4ffc53a14ecb496d2ca5014ff9d19b0061ad9/docs/limitations.md), [security status](https://celld.dev/docs/security/)

**Verdict:** celld is effectively “Durable Objects without Cloudflare,” not the full computer Vivid needs. Using it for state while another host runs browsers and tools would immediately recreate the split the product is trying to avoid.

### OpenSession

OpenSession is the strongest packaging and durability precedent in the local references. Its simple mode ships one compiled executable with the frontend embedded. The executable re-execs itself for internal roles such as gateway, executor, runner host, MCP proxy, and session-kernel service. [Simple-mode ADR](https://github.com/tellahq/opensession/blob/b9444ac971bffecf1daa2c3bee6e4ce104e036ed/adrs/simple-mode.md)

Its runtime gives each session one logical `SessionKernel`: a serial mailbox and authoritative SQLite store. Slow or dangerous filesystem, process, network, and model work is represented as durable/fenced effects, then performed outside the mailbox by executors. [Session-kernel architecture](https://github.com/tellahq/opensession/blob/b9444ac971bffecf1daa2c3bee6e4ce104e036ed/docs/session-kernel-architecture.md), [executor architecture](https://github.com/tellahq/opensession/blob/b9444ac971bffecf1daa2c3bee6e4ce104e036ed/docs/executor-architecture.md)

**Meaning for Vivid:** one deployable may still supervise several local processes. Start as one daemon; add internal process boundaries only where crash isolation, privilege separation, or responsiveness proves they are needed. Copy the invariant—persist intent before side effects—not OpenSession’s full mature topology on day one.

### Grok Bot 0.30 reconstruction

This evidence is from the local evidence-only reconstruction in `~/refs/grok-bot-0.30-reconstructed`, not official source code. Its `PROVENANCE.md` explicitly warns against presenting it as official.

The observed design places remote cloud boxes and a local Docker box behind the same host-connector interface. The local path starts one restartable full-Linux container, persists `/workspace` and application data in named volumes, and exposes gateway and VNC endpoints on localhost. The box then owns the long-lived host, agent runtime, browser/desktop, files, and local database; an execution daemon is an internal process.

Relevant evidence: `source/electron-main/box/box-host-connector.ts`, `source/electron-main/box/local-docker-host-connector.ts`, `source/host/main.ts`, `source/node-agent-coordinator/main.ts`, and `source/packages/agent-store-sync/local-index.ts`.

The reconstruction does include Vercel AI SDK 4 and calls `streamText` in its OpenRouter provider path. That path is a reconstructed inference adapter. The broader runtime is a custom Cursor-style system of protobuf conversation state, action handlers, checkpoints, tool runners, and coordinator processes. This is not evidence that the core is a “fork of AI SDK”; it is evidence that an AI SDK can sit below a much larger product runtime.

**Meaning for Vivid:** define a provider-neutral computer connection. Local machine, local container, and remote VM should present the same protocol. The host provider supplies a machine; it does not become Vivid’s domain model.

#### The four backend surfaces are planes, not four runtimes

The 0.30 bundle exposes 224 `BackgroundComposerService` methods, 189 `AiService` methods, 106 `GrokBotService` methods, and 37 `SandBoxService` methods. These counts come from the extracted descriptor surface and do not prove that every endpoint is used by the product. The important finding is the ownership split:

| Surface                           | What it actually spans                                                                                                                                                                                          | Closest Vivid owner                                    | Supplied by Flue / AI SDK?                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `BackgroundComposerService` (224) | Remote-agent lifecycle and conversation streams, follow-up queue, snapshots/forks, environments/builds, artifacts, push/live activity, private workers, agent stores/file locks, keyrings and Git/PR operations | Runtime control plane plus workspace/artifact services | Flue or `WorkflowAgent` covers the inner turn loop only. Vivid still owns the product index, schedules, permissions, artifacts and placement. |
| `AiService` (189)                 | Model/inference catalog and streaming, token counting, routing, reranking, embeddings/search, speech, image generation, prompt helpers and evaluation                                                           | Model/media provider layer                             | AI SDK providers cover much of this. Do not reproduce one giant inference RPC surface for v1.                                                 |
| `GrokBotService` (106)            | The 37 sandbox operations plus product APIs: transcript sync/presence, agents, templates/marketplace, messages/interrupts, widgets/reactions, approvals, user-computer handoff, Slack and admin publishing      | Vivid product API/control plane                        | Neither framework supplies it. This is Vivid itself.                                                                                          |
| `SandBoxService` (37)             | Machine broker lifecycle, upgrade/migration/reset/hibernate, presigned box-store I/O, snapshots/restore/status, setup manifests, team boxes and voice-call secret                                               | Computer/executor host control plane                   | Neither framework supplies a whole computer. A sandbox SDK is only an adapter behind this boundary.                                           |

`SandBoxService` is not 37 additional unrelated methods beside the 106. In 0.30 it is exactly the first 37 sandbox methods mirrored by `GrokBotService`, which indicates a service extraction or compatibility migration. Vivid should start with clean internal module boundaries, not copy that duplicated public RPC surface.

#### Filesystem shape

The local Docker path starts one restartable Linux container and mounts two named volumes: `/workspace` and `/home/box/sand-data`. It also mounts the host and exec-daemon bundles read-only, optionally mounts local Codex/Claude auth read-only, and publishes the gateway, exec, fork-router, noVNC and related ports only on loopback.

The remote durability path is not a live S3-mounted POSIX filesystem. The machine works against its ordinary local filesystem, while a box-store layer periodically snapshots selected roots into a content-addressed object store:

- `/workspace`;
- `/home/box/sand-data`, including per-agent SQLite state captured safely;
- CLI config;
- staged Chrome session/auth data and, while idle, selected Chrome profile data;
- optionally broader `/home/box` state with regenerable caches excluded.

The store uses a versioned manifest, SHA-addressed blobs, modes and symlinks, multipart presigned transfers, atomic temporary-file restore, hydration verification, conflict handling, and startup copy-in. It is backup/migration/recovery around a live disk, not the filesystem agents execute against. Vivid should copy this distinction: one durable mounted POSIX volume is authoritative while a machine is alive; object storage is an optional snapshot/restore adapter, never required to boot a local install.

#### Execution and computer glue

```text
agent tool call
  -> runtime resource accessor + policy/approval/audit
  -> authenticated internal ExecService
  -> box exec daemon on loopback
  -> shell/read/write/background process OR desktop action
  -> result + persisted screenshot/artifact

human desktop view
  -> noVNC URL from the same box/window
  -> trusted Electron webview or remote/mobile client
  -> clipboard + presence bridge
```

The exec daemon resolves ordinary relative paths under `/workspace`, rejects escapes and unsafe symlink reads, streams foreground commands, owns background shells and terminal logs, and handles file transfer with temporary writes followed by atomic rename. The host wraps those low-level resources with readiness, cancellation, permission/auto-review, audit and artifact persistence.

Computer use is a separate generated executor resource for screenshot, click, move, drag, type, key, scroll and wait. Each agent receives an assigned X11 desktop window; a primary noVNC endpoint and fork-window router expose interactive viewing, while owner/display tokens prevent cross-window control. Browser tools run inside the same assigned display against its box-local Chrome CDP endpoint, so structured browser automation and visual computer control operate on the same visible browser. The desktop stream is not tunneled through the chat stream.

There is also a distinct **user-computer provider/handoff** path. The 0.30 product API can issue a computer credential, watch or poll requests, submit streamed responses, list/open/cancel a user computer, and end a box handoff. The reconstructed local-exec bridge routes shell/file requests to a live registered device provider with heartbeats, cancellation, approval ids and response watchdogs. This path does not mount the host filesystem into the remote box: a supervised daemon executes directly on the user's machine within a configured root, defaulting to the user's home directory, and rejects path/symlink escapes. This lets an agent temporarily operate “this computer”; it is not the same feature as letting a phone view and control the agent's remote box. Vivid needs both contracts separately if it wants both capabilities.

For Vivid, the minimum correct boundary is therefore `Runtime -> Executor/Computer protocol -> local process, local container, or remote machine`. It may all ship as one install with supervised child processes. Filesystem, browser media/control, and side-effect execution should not be encoded as chat transport features.

## Final runtime recommendation — committed cutover

This decision supersedes the earlier candidate comparison:

- **Agent turn engine:** Flue Node owns the Pi loop, durable submission queue, conversation journal, partial-stream recovery, tool checkpoints, leases, settlement, and client observation.
- **Product runtime:** one long-lived Node Vivid daemon structured with Effect services. It owns users, teams, teammates, threads, permissions, policies, schedules, connector installations, artifacts, audit records, notifications, and the product projection around Flue conversations.
- **Product background work:** use Effect's ordinary concurrency primitives for ephemeral work. Use Effect's durable workflow primitives only when a product job outside the agent turn—such as a schedule, connector ingestion, or provisioning—must survive restart. Do not wrap each Flue turn in an Effect workflow.
- **Execution:** an `Executor/Computer` protocol runs shell, files, browser, desktop, and connector side effects. Begin in the same host or supervised child process; preserve the protocol so a local computer, container, or remote VM can implement it later.
- **Deployment:** one Vivid Node application on a laptop, ordinary Linux VM, or container. Configure Flue with an explicit file-backed SQLite path inside the Vivid state directory; its default `:memory:` database is not durable. A process supervisor restarts the daemon, then Flue reconciles unfinished work. Postgres, Nitro, Graphile Worker, Cloudflare, and a separate queue service are not required.
- **Workspace:** the selected execution environment owns the live POSIX workspace. A cloud runtime uses a persistent volume. A user's laptop filesystem is an optional execution target exposed through a restricted local daemon; it is never mounted as the canonical Vivid filesystem. A phone mounts nothing.
- **Clients:** Flue observation is the canonical conversation source. A framework-neutral Vivid client store combines it with approvals, artifacts, attention state, and product commands. Web and Electron render that store with AI Elements where useful; Expo renders the same view model natively. `useChat` is not a second state owner.

### Why Flue rather than WorkflowAgent or OpenSession?

They operate at different layers. The deciding constraint is the portable, self-contained runtime—not which option most closely matches an existing React hook.

| Boundary                   | AI SDK `WorkflowAgent`                                                            | Flue                                                                                        | OpenSession                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Primary scope              | One durable AI agent run                                                          | Durable conversation runtime                                                                | Full product-specific session kernel and executor system                                               |
| Admission and ordering     | Durable workflow run, but no built-in Vivid thread inbox or one-active-run policy | Durable submission before model work; ordered per-conversation queue and one owner          | Durable commands, request receipts, serialized actor mailbox, run generations                          |
| Conversation truth         | AI SDK UI messages/stream; Vivid must own the canonical shared thread             | Canonical append-only conversation stream                                                   | Kernel-owned SQLite state and monotonic projections                                                    |
| Model and tool recovery    | Each tool can be a durable workflow step with retry/persistence                   | Attempts, leases, partial-stream recovery, committed durable tool results                   | Durable intents/outbox, supervised runners, fenced results                                             |
| Human approval             | Native AI SDK approval suspension and resume                                      | No complete native AI SDK approval/client-tool contract                                     | Durable asks exist, but use a custom product protocol                                                  |
| Client integration         | Native `useChat`, typed UI parts, resumable stream                                | Its own observation client; a `useChat` bridge loses semantics                              | Custom gateway/WebSocket/projection system                                                             |
| Ambiguous external effects | Workflow is at-least-once; Vivid tools still need idempotency and receipts        | Unknown outcome for interrupted ordinary tools; durable tools replay recorded results       | Strongest: persist intent first, stable operation ids, outbox, indeterminate state, generation fencing |
| Workspace/computer         | Outside its scope                                                                 | Workspace durability is separate                                                            | Explicit executor/run-host architecture and lifecycle                                                  |
| Production state           | Postgres World; embedded Graphile Worker; Workflow 5 beta                         | File-backed SQLite with one Node owner; other adapters do not imply active-active ownership | Per-session/catalog SQLite plus supervised local services                                              |

`WorkflowAgent` is the highest-level AI SDK option, but its production path adds Workflow infrastructure and Postgres while leaving Vivid to own canonical multi-client product state. Flue supplies the portable Node/SQLite durability envelope and canonical conversation observation that Vivid needs. OpenSession provides the broadest defensive runtime model, but it is an architecture to learn from rather than a reusable agent SDK. [WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent), [Flue durability](https://flueframework.com/docs/guide/durability/), [OpenSession session kernel](~/refs/opensession/docs/session-kernel-architecture.md)

Vivid still owns the product invariants Flue does not:

1. Users, organizations, memberships, teammate and thread indexes.
2. Durable approvals, policy decisions, and audit records.
3. Product schedules, connector installations, notifications, and attention state.
4. Stable operation ids and receipts for external side effects.
5. Workspace, artifact, computer, and executor lifecycle.

These surround Flue; they do not reproduce its submission journal or conversation runtime.

### External services actually required

- **Local and single-host production:** no state service is required. Flue and Vivid use file-backed SQLite inside the persistent state directory. A model API is external unless models run locally.
- **Process availability:** the operating system, desktop app, or container platform must restart the daemon. SQLite preserves work but cannot execute while the program is stopped.
- **Runtime storage:** a persistent block/file volume is required for the live cloud workspace. S3-compatible storage is optional for the first single-host proof, but required before claiming host-loss recovery, portable snapshots, large artifact storage, or migration.
- **Execution:** the executor starts in-process or as a supervised child. A separate VM/container fleet is a later placement choice, not an initial service dependency.

### Where durability runs, and whether Vivid needs RPC

The agent durability engine runs inside the long-lived Vivid Node application:

```text
Vivid Node process
  Vite assets + HTTP/realtime API
  Flue Node runtime + AgentCoordinator
  Effect application services
  in-process Executor interface initially
       |
       +--> file SQLite: submissions, journal, streams, Vivid product state
       +--> POSIX volume: live workspace and artifacts
       +--> S3 later: artifacts and snapshots
```

Flue's coordinator claims SQLite submission rows, renews leases, drives attempts, and reconciles interrupted work on startup. SQLite stores the durable facts; the coordinator and recovery policy execute them. Effect supplies service composition, typed errors, scopes, concurrency, and surrounding product jobs. Running Effect durable workflows around every Flue turn would duplicate ownership and recovery semantics.

RPC is a transport boundary, not a durability engine. Vivid does **not** need ConnectRPC, protobuf, or Effect RPC between modules living in the same Node process. Use ordinary typed Effect service interfaces there. Clients cross the Flue/Vivid HTTP and durable-stream boundary. Introduce an executor RPC only when the executor moves to a supervised child process, container, user's laptop, or remote VM. Effect RPC is a candidate at that point, but the `Executor/Computer` contract must not depend on one transport.

### What Grok Bot's durability layer actually is

Grok Bot 0.30 does **not** contain one generic durability engine comparable to Workflow, Temporal, or Effect Workflow. It implements product-specific durability across several stores and recovery paths:

- **Agent checkpoint:** conversation state is split into content-addressed blobs. A per-agent store records `latestRootBlobId`; recovery loads that root and reconstructs the state graph. [checkpoint code](~/refs/grok-bot-0.30-reconstructed/source/packages/agent-kv/agent-store.ts)
- **Transcript and session state:** per-agent SQLite stores transcript entries and KV metadata. It uses WAL, transactions, integrity checks, corrupt-file quarantine, and row salvage. [schema](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/session/agent-db-schema.ts), [recovery](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/session/agent-db-recovery.ts)
- **Durable prompt admission:** a nonce-and-input-digest acceptance ledger records pending, accepted, or rejected sends; accepted transcript echoes are persisted before being emitted. This makes client retries inspectable and deduplicable. [acceptance ledger](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/transcript/prompt-acceptance-ledger.ts), [persist-before-emit](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/transcript/send-acceptance.ts)
- **Restart repair:** atomic JSON marker files remember unacknowledged sends, pending background wakes, and upgrade resumes. Boot logic rearms or redrives what it safely can. [ack obligations](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/transcript/ack-obligations.ts), [pending wakes](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/transcript/pending-wake-rearm.ts)
- **Host-loss backstop:** the local `store.db` can be checkpointed and uploaded to the object store; workspace files have their own live-disk plus object-store sync. [state backstop](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/state-backstop/state-backstop-service.ts)
- **Cloud/product sync:** the visible backend contract exposes transcript commit/list/watch and send-status calls, but the reconstructed client does not reveal the backend database or queue implementation. [backend inventory](~/refs/grok-bot-0.30-reconstructed/source/surface/0.30.0-backend-service-methods.json)

The important limit is that its per-agent run scheduler is an in-memory `Map`; a process restart does not replay an arbitrary interrupted model/tool run. The recovery code explicitly reports that an in-process subagent run did not survive and may need redispatch. Grok therefore has durable checkpoints, admission, delivery obligations, and reconciliation—not general step-level workflow replay. [scheduler](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/transcript/run-scheduler.ts), [lost-run recovery](~/refs/grok-bot-0.30-reconstructed/source/host/extensions/transcript/pending-wake-rearm.ts)

RPC is not part of that durability layer. It is necessary only where Grok crosses renderer, child-process, cloud-box, executor, or backend boundaries. The SQLite/checkpoint/ledger machinery would still be the durability mechanism if those pieces shared one process.

### What Grok Bot's RPC architecture is actually doing

The reconstructed 0.30 files show several independent RPC planes, each matching a real process, machine, or trust boundary. RPC is the connective tissue; it is not the agent runtime or durability mechanism.

```text
React renderer
  -> Electron main RPC edge
  -> coordinator child-process MessagePort RPC
  -> per-user box gateway: JSON commands + SSE events
  -> executor daemon: Connect/protobuf streaming RPC

host/coordinator
  -> Cursor cloud: ConnectRPC/protobuf services
```

1. **Renderer to Electron main.** A generated/central method table exposes desktop-only capabilities such as files, updates, settings, auth, MCP and window control. Every handler requires the trusted application top frame. This keeps Node/filesystem credentials out of the renderer and makes the Electron security boundary explicit. [method table](~/refs/grok-bot-0.30-reconstructed/source/shared/rpc/main.ts), [trust policy](~/refs/grok-bot-0.30-reconstructed/source/electron-main/main-edge.ts)
2. **Renderer/main to coordinator.** In 0.30, former host responsibilities moved into a separately forked `node-agent-coordinator`. Transferable MessagePorts carry versioned `hello/ready/shutdown`, request, cancel, reply and event frames. The separate process can be restarted, account-fenced and kept away from renderer lifecycle stalls. [0.30 architecture note](~/refs/grok-bot-0.30-reconstructed/README.md), [port protocol](~/refs/grok-bot-0.30-reconstructed/source/shared/rpc/coordinator-port.ts), [launcher](~/refs/grok-bot-0.30-reconstructed/source/electron-main/coordinator/coordinator-launcher.ts)
3. **Coordinator to the user's cloud box.** Commands are JSON `POST`s; live agent/transcript/computer state returns through one reconnecting SSE stream. Client nonces, accepted receipts, timeouts, endpoint pinning and dedupe-aware retry avoid blindly replaying a possibly accepted prompt. This boundary exists because the box is remote and can migrate or reconnect. [gateway client](~/refs/grok-bot-0.30-reconstructed/source/node-agent-coordinator/gateway/gateway-client.ts), [box broker](~/refs/grok-bot-0.30-reconstructed/source/electron-main/box/box-host-connector.ts)
4. **Runtime to executor.** Generated protobuf messages represent shell, files, MCP and computer operations. The stream carries correlated results, cancellation, close/error control frames, heartbeats and trace context. The same logical executor contract can target the box-local daemon or a user's computer without giving the model direct transport knowledge. [controlled executor](~/refs/grok-bot-0.30-reconstructed/source/packages/agent-exec/controlled.ts), [box exec daemon](~/refs/grok-bot-0.30-reconstructed/source/box-exec-daemon/server.ts)
5. **Desktop/host to Cursor's backend.** ConnectRPC clients are generated from protobuf service descriptors and use interceptors for bearer auth, machine/client identity, privacy headers, request lineage and tracing. The 0.30 inventory contains `AiService` (189 methods), `BackgroundComposerService` (224), `GrokBotService` (106), and `SandBoxService` (37). The complete `SandBoxService` method list is duplicated as the opening surface of `GrokBotService`, which points to API evolution/compatibility rather than a clean fourth runtime component. These are mature shared Cursor backend surfaces—not four processes the desktop deploys. [backend inventory](~/refs/grok-bot-0.30-reconstructed/source/surface/0.30.0-backend-service-methods.json), [Connect client](~/refs/grok-bot-0.30-reconstructed/source/shared/node/cursor-backend/cursor-inference.ts)

The source does not contain a design memo saying “we chose RPC because…”. The defensible inference from these boundaries is: generated contracts let a large product move typed commands, streams, cancellation, auth and trace context across Electron, child-process, cloud-box and backend boundaries without importing the implementation into every caller. Grok Bot's large RPC taxonomy is also historical platform surface; it is not evidence that a new product should begin with hundreds of methods or separately deployed services.

**Vivid should copy the boundary discipline, not the sprawl:**

- Flue's durable conversation stream remains the agent-turn protocol and canonical client source.
- One Vivid product API owns teams, threads, schedules, connectors and product events.
- One `Executor/Computer` RPC contract owns shell, filesystem, browser and desktop operations, including cancellation, heartbeats, stable operation ids and explicit outcomes.
- Electron IPC is a narrow trusted desktop adapter only. Web and mobile never call it.
- These can initially live in one Node application plus a supervised executor child. An RPC contract is not permission to split them into independently deployed services.

### Cloud persistent filesystem plus S3

This is feasible, but they have separate jobs:

```text
file-backed SQLite               persistent POSIX volume           S3-compatible store
submissions, journals, leases    live mutable /workspace           uploads and artifacts
conversation + product state     Git, builds, tools, SQLite files  versioned snapshots/backups
receipts and schedules           normal file locking and rename    migration/restore blobs
```

The agent executes only against the POSIX volume. S3 is not the live filesystem: object-store mounts do not provide the complete mutation, locking, symlink, and rename behavior that developer tools expect. [Amazon EBS features](https://docs.aws.amazon.com/ebs/latest/userguide/EBSFeatures.html), [Mountpoint for Amazon S3 behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mountpoint.html)

Use one fenced writer per workspace and Vivid installation. Before a run, attach or hydrate the volume and start the single owning daemon. On idle/checkpoint, upload a versioned manifest plus immutable blobs/archive to S3 and record its hash in Vivid state. To move hosts: fence the old generation, stop writes, checkpoint, attach the same volume or restore its snapshot, then start the new owner. Quiesce SQLite databases or use their backup API before snapshotting. The phone reads workspace metadata/previews through Vivid's API and downloads artifacts through short-lived URLs; it mounts nothing.

Effect v4 does contain a real durable workflow stack. `DurableQueue` delegates to a persisted queue and durable deferred, while `ClusterWorkflowEngine` persists executions, activities, deferred completions, resumes, interrupts, and clock wakeups. `SingleRunner` packages its SQL-backed message storage for a local, embedded, or small single-node process. This is different from plain `Effect.Queue`, which is memory-only. It is useful for Vivid's surrounding product jobs, but using it as the agent turn engine would duplicate Flue's ownership, journal, and recovery semantics.

T3 validates the remote-client shape, not filesystem mounting. A T3 environment is the server and the machine that owns its projects, files, Git state, terminals, provider sessions, and thread history. Mobile, hosted web, and desktop save that environment and connect to it over HTTP/WebSocket after pairing. The client fetches thread snapshots over HTTP and receives/submits live state and commands over WebSocket. With LAN, Tailscale, HTTPS, or SSH forwarding, the environment still owns the work; the hosted web app explicitly does not proxy it. If the environment runs on a laptop, that laptop must remain reachable. Vivid's always-on version places the same environment in the cloud and makes the laptop an optional executor.

### Build order

1. **Flue Node cutover first.** Replace the current fake/placeholder turn path with one real Flue conversation, an explicit file-backed SQLite path, one ordinary tool, persisted messages, and durable observation through the current Vite client. Render it with AI Elements through a Vivid view adapter. Keep this slice as production code.
2. **Kill/restart and ledger proof.** Stop the Node process during admission, model call, tool execution, and pending approval. Verify receipts, ordering, generation fencing, duplicate submit/cancel handling, and explicit indeterminate outcomes for unsafe external retries.
3. **Second-device proof.** Start on web/desktop, reconnect from Expo, see the same thread and stream, approve or interrupt once, and continue without duplication.
4. **Executor/computer and storage.** Give the cloud runtime one persistent POSIX workspace; survive a container restart; checkpoint it to S3; restore it on another host. Implement shell, file, browser, and desktop operations behind the provider-neutral protocol.
5. **Product workflows.** Add Effect durable schedules, connector ingestion, notifications, provisioning, and receipts around the proven agent core.
6. **Package once.** Ship the daemon as one OCI image for an ordinary Linux host. Change configuration and executor adapters—not application semantics—for local or cloud placement.
7. **Optional local computer.** Add an outbound authenticated local daemon when Vivid needs to operate the user's own files or desktop.

The first cutover milestone is deliberately narrow because this runtime stack is new. A pending approval and streamed run must survive a daemon restart and resume from a second device before more product features are placed on it. A failure that requires patching Flue's private journal or coordinator is a concrete architecture blocker and triggers an explicit decision review.

## Decision boundaries

- Do not design the runtime backwards from a deployment provider.
- Do not split modules into independently deployed services merely because cloud primitives encourage it.
- Do not build or retain a second agent runtime behind a speculative compatibility abstraction. The committed runtime is Flue Node; Think, WorkflowAgent, and OpenSession remain references or rejected alternatives.
- Do not require Postgres, Nitro, object storage, Cloudflare, or a provider-specific runtime to start Vivid. File-backed SQLite is the required state substrate for the initial single-owner runtime.
- Do not require every client to embed its own agent runtime.
- Do keep the runtime protocol transport-neutral so desktop, web, mobile, and team use can share it.
- Do keep provider adapters narrow enough that Vivid can move from a laptop to Docker to a VM without changing agent semantics.

This leaves the team and organization model intact. It only says that reachability, collaboration, and placement sit around the runtime; they do not replace or fragment it.

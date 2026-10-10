# State machines in Vivid

**Decided 10 October 2026: client lifecycles are machines on `@typeonce/effect-machine`.** The rule is in `AGENTS.md` ("Lifecycles are machines"); the first machine is `packages/client/state/src/connecting.ts`. Everything below the next heading is the evaluation of 20 September 2026, kept for its reasoning; its version numbers and its "deferred" status are superseded by this section.

## What was run on 10 October 2026

Both candidates were installed against Effect 4.0.2 and driven through the same Integration press flow (press, ask the server, sign in away from the app, come back, key form). Nothing here is from documentation alone.

| Check                                                                    | `@xstate/effect` 0.1.0-alpha.7 on XState 6.0.0-alpha.65 | Effect Machine 0.40.0   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------- |
| An event the state does not take is refused                              | yes                                                     | yes                     |
| A double press makes one call; cancel interrupts it; late answer ignored | yes                                                     | yes                     |
| Unknown target state, wrong event payload                                | compile error                                           | compile error           |
| Entering a state without its data                                        | compile error                                           | compile error           |
| Reading another state's data                                             | allowed                                                 | not tested              |
| A call that can fail with no failure transition                          | allowed                                                 | compile error           |
| "Can this event be sent now" as an atom                                  | not tested                                              | yes (`AtomMachine.can`) |
| Works through the Effect atom registry                                   | yes                                                     | yes                     |
| Events per second, one rough run                                         | about 11,000                                            | about 53,000            |
| Added size, minified / gzip, Effect excluded                             | 170 KB / 53 KB                                          | 166 KB / 45 KB          |

Effect Machine was chosen because it rejects more mistakes at compile time, above all a call whose failure has nowhere to go. What XState has and Effect Machine does not: a maintaining company and nine years of history. Effect Machine is one maintainer and was ten weeks old at the decision, and its README says breaking changes ship in minor releases; the version is pinned in the workspace catalog for that reason.

Both libraries' atom bridges import `effect/reactivity`, which Effect 4.0.0-rc.116 did not have, so the move to Effect 4.0.2 came first.

A static survey the same day found about forty client lifecycles held in `useState` or stores, most of them written twice (web and phone), about twenty with a concrete overwrite by a late answer. `vivid/react-no-state-after-wait` counts the sites; the ratchet in `scripts/gate/ratchets.mjs` is the list that is left.

Two things to know when writing one:

- A state is published before its invoked work starts. A test that answers "the call in flight" the moment it sees the state can answer before the call exists; hand answers through a queue.
- Snapshot restore restarts a state's work from the beginning. A machine is not durable execution and does not replace a database transaction, an idempotency key, or Flue's submission receipts.

Not yet run at the decision: either library inside the Expo app on Hermes.

# The evaluation of 20 September 2026 (historical)

## Options and version snapshot

Versions below record the evaluation, not a recommendation to install without rechecking.

| Option                       | Evidence at evaluation                                                                                                                         | Main tradeoff                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Effect Machine               | Upstream manifest declares 0.38.0 and an exact Effect `4.0.0-rc.116` peer, matching Vivid.                                                     | Effect-native schemas, planning, scoped execution, and statecharts; young API and experimental tooling.         |
| XState plus `@xstate/effect` | rat-stack pins XState `6.0.0-alpha.58`, a vendored bridge `0.1.0-alpha.2`, and Effect `4.0.0-rc.115`.                                          | Established XState ecosystem, but this specific Effect integration is alpha and needs compatibility validation. |
| Existing Vivid approach      | Effect programs, schemas, guarded persistence, and Flue conversation execution. Neither machine library was present in the evaluated checkout. | Appropriate for simple behavior; transition rules can become scattered as lifecycles grow.                      |

The local VCOS checkout at `~/work/VCOS` uses `@typeonce/effect-machine@0.3.0`
with Effect rc.112 for lifecycle transitions, active-run coordination, Connection catalog state,
and review workflows. Treat it as a design reference, not current API guidance. Adapt any borrowed
design to Vivid's names and ownership boundaries.

rat-stack is an application scaffold, not the library VCOS uses. Its shared schema-backed
capability projected into HTTP, CLI, and MCP is useful inspiration, but does not justify a stack
migration. Vivid already has Effect, Alchemy, and quality gates; deployment provider choice is
independent of state-machine choice.

## Current application fit

| Area                                | Observed behavior                                                                                               | Recommendation                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Connection authorization            | Web and mobile separately manage authorization, retry, errors, returning from sign-in, and Thread continuation. | Best first trial: share the transition controller, retain native platform adapters.                                             |
| Routine Occurrences                 | Three result states plus persisted Flue submission receipts and guarded completion.                             | Keep the current approach until cancellation, approval, pause, or overlapping-run policy adds meaningful transition complexity. |
| Library ingestion                   | Mostly linear read, extract, and index work.                                                                    | Keep Effect programs; reconsider for resumable stages, cancellation, or richer retries.                                         |
| Notification read state, navigation | Mostly simple values and updates.                                                                               | Schemas and direct functions suffice.                                                                                           |
| Conversation streaming              | Flue owns conversation execution and lifecycle.                                                                 | Preserve its authority; do not mirror it into a competing machine.                                                              |

Local evidence:

- [Web Connection request card](../apps/web/src/ui/connector/Card.tsx) and
  [mobile Connection request card](../apps/mobile/src/ui/connector/Card.tsx).
- [Mobile resource store](../apps/mobile/src/data/resource/store.ts): subscription lifetime,
  foreground refresh, and stale-response handling already have an owned implementation.
- [Routine scheduler](../apps/server/src/routines/scheduler.ts) and
  [Routine store](../apps/server/src/routines/store.ts), including one-off reminders.
- [Library ingestion](../packages/agent/runtime/src/library-ingest.ts).

## Future application fit

These are evaluation candidates, not claims that the complete features are implemented.

| Capability                        | Rules a machine could centralize                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Approvals and Input requests      | Pending, answered, rejected, expired, and cancelled states; late responses and competing decisions from multiple devices.     |
| Computer lifecycle                | Starting, restoring, verifying readiness, capturing changes, stopping, and recovery. Work must wait for verified restoration. |
| Human takeover                    | Control ownership, when Vivid must stop acting, and what authorizes resumption.                                               |
| Offline commands and reconnection | Local queueing, submission, acknowledgement, rejection, and safe retry.                                                       |
| Routine installation              | Required Connections, configuration, confirmation, installation, failure, and retry.                                          |

Computer availability, control ownership, and archive synchronization are separate concerns. Model
their relationships explicitly rather than enumerating every combination in one giant machine.
Existing [restore verification](../packages/computer/src/restore.ts) and
[capture conflict handling](../packages/computer/src/capture.ts) remain authoritative guarantees.

Related product direction: [Computer](04-computer.md),
[platform architecture](09-platform-architecture.md),
[Routines](13-routines-and-templates.md), including reminders and other one-off commitments.
Older documents contain historical implementation details; verify current source before adoption.

## Capabilities and limits

Both options support hierarchical and parallel states, transition planning, and scoped Effect
execution through their respective runtimes. Effect Machine also supplies model-based testing
and experimental devtools. Its devtools walkthrough does not execute application Effects or
guards, so a visual path is not proof of runtime behavior.

Saving a machine snapshot does not provide durable execution. Effect Machine serializes logical
state, not running fibers, queues, or child processes; decoding does not restart those processes.
XState restoration restarts invocations, which can repeat external work. Neither replaces Flue
submission receipts, idempotency keys, database transactions, or concurrency checks.

Effect Machine's unstable Cluster adapter rejects process-local invokes and commands. Do not
assume it is a general durable workflow replacement. Snapshot schema upgrades also remain an
application responsibility; version mismatch rejection is not a migration strategy.

React integration exists for both options. The exact versions evaluated have not been proven in
Vivid's Expo/Hermes environment. Bundle impact, startup cost, streamed-update behavior, and native
mount/background/unmount semantics remain unmeasured.

## Revisit scope and acceptance criteria

Begin with one Connection controller in `packages/client/rpc`. Shared wire schemas belong in
`packages/contracts`. Browser popup creation must remain synchronous with the user gesture;
native link opening and foreground notifications remain native adapters. The server remains the
authority for Connection status and credentials. The machine owns client interaction state.

- [ ] Recheck current package versions, peer dependencies, APIs, and release status.
- [ ] Define states, events, failure cases, and ownership before choosing runtime APIs.
- [ ] Use one transition implementation from web and mobile; account for future desktop reuse.
- [ ] Prove repeated clicks and late responses cannot trigger duplicate Thread continuation.
- [ ] Prove sign-in failure, cancellation, retry, and return from authorization behave correctly.
- [ ] Verify request cancellation, stale-result rejection, unmount, background, and foreground behavior.
- [ ] Run the real web and Expo clients; measure bundle/startup impact against the existing implementation.
- [ ] If state is persisted, prove snapshot round trips and an explicit upgrade fixture.
- [ ] Demonstrate removal of meaningful duplicated behavior without adding framework workarounds.
- [ ] Record adopt/defer/reject with evidence; only then consider follow-ups or future lifecycles.

Persisted server lifecycles require additional race and restart tests through real storage and
Flue seams. Follow the isolated test-database policy. Keep production scheduling, execution,
credential handling, and computer-control implementations in their existing owned systems.

## Sources

- [rat-stack README and version pins](https://github.com/joelhooks/rat-stack/blob/main/README.md)
- [rat-stack Effect/XState example](https://github.com/joelhooks/rat-stack/blob/main/packages/core/src/inspect-machine.ts)
- [Effect Machine manifest](https://github.com/typeonce-dev/effect-machine/blob/main/packages/effect-machine/package.json)
- [Effect Machine runtime documentation](https://github.com/typeonce-dev/effect-machine/blob/main/packages/effect-machine/README.md)
- [Effect Machine public planning and snapshot API](https://github.com/typeonce-dev/effect-machine/blob/main/packages/effect-machine/src/Machine.ts)
- [Effect Machine Cluster adapter](https://github.com/typeonce-dev/effect-machine/blob/main/packages/effect-machine/src/internal/machine/cluster.ts)
- [Effect Machine testing](https://github.com/typeonce-dev/effect-machine/blob/main/packages/effect-machine/src/testing/MachineTest.ts)
- [Effect Machine devtools](https://github.com/typeonce-dev/effect-machine/blob/main/packages/devtools/README.md)
- [XState persistence](https://stately.ai/docs/persistence)
- [XState graph and testing utilities](https://stately.ai/docs/graph)

Upstream links follow moving branches. Revalidate the dated findings when this work resumes.

# References

2026-10-03: Historical reference inventory; Vivid’s earlier SQLite runtime choice is superseded by PostgreSQL, HelixDB memory, Executor Integrations, and Boat; current implementation evidence is in [docs/14](14-product-feature-set-and-grok-bot-parity.md).

Public and local reference systems used to inform Vivid. Proprietary project names and paths are
intentionally omitted.

## Prior internal product work

Earlier workspace products combined chat, tasks, routines, capabilities, documents, approvals, and
organizational memory in one tabbed app.

Take: the product idea itself, the trust matrix and audit row per call, the approvals model, the
organizational-memory direction, connector assembly, scheduling, and memory retrieval. Leave: the
dashboard navigation and Cloudflare deployment topology.

## Cloudflare OS

`~/os`, cloudflare/cloudflare-os v2. Agent chat preloaded with company context, sandboxed
user-built "gadget" apps, and the Gatekeepers security framework that lets non-technical staff go
wild safely.

Take: Gatekeepers as the model for "what may Vivid do". Leave: the app-building surface.

## Open Session

`~/refs/opensession`, tellahq/opensession. Self-hosted agent server that drives coding sessions
through the Pi engine, reached from a web UI and Slack, Linear, Plain, and GitHub. Source under
`packages/core/opensession-server/src/frontend`.

Take: the in-thread mechanics. See [Surface](03-surface.md). Leave: the sidebar, PR and review
chrome, model and mode pickers, cost readouts.

## Grok Bot

`~/refs/grok-bot-0.30-reconstructed`, an evidence-only source-level reconstruction of the Grok Bot desktop app.
Readable React renderer, Electron host, session runtime, coordinator, local-exec with computer use,
and the box.

Take: onboarding order, face and name, sentence-style suggestions, teach a task, the whole box
model, and the provider-neutral local/remote computer connector. See [Surface](03-surface.md) and
[Computer](04-computer.md). Leave: bots plural, the plugin category grid, and cloud account
dependencies.

## Flue

[Flue](https://github.com/withastro/flue), by the Astro team. A Vite-based agent framework with an
ordinary Node target and a separate Cloudflare target.

Vivid has selected its Node runtime as the agent core: durable admission and recovery, canonical
conversation streams, sandbox adapters, and a file-backed SQLite deployment shape. Flue's client
observation state remains canonical; AI Elements renders the resulting Vivid view model. Leave:
its Cloudflare Durable Object target and its product assumptions about users, permissions, and UI.

## celld

`~/celld`, denoland/celld. Ryan Dahl's self-hosted Durable Objects runtime: one Rust daemon running
Wrangler bundles, with cell state replicated through an object-store bucket.

Take: named actors and per-actor SQLite as a later scaling reference. Leave: the Workers programming
model, required bucket, and missing full filesystem/process environment.

## Cloudbox (Vivid built this)

`~/cloudbox`, with product docs in `~/cloudbox-product` and the T3 Code fork in `~/t3code-cloudbox`.
One persistent VM in the user's own cloud account that runs T3 Code headlessly, suspends when idle,
wakes on explicit intent, and carries the user's identity into per-thread machines.

Take: the host and lifecycle layer of Vivid's computer. See [Computer](04-computer.md).

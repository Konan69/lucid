---
name: effect
description: |
  Opinionated guide for building, reviewing, fixing, and refactoring production TypeScript applications with Effect v4. Use when implementing or improving Effect workflows, services, layers, schemas, configuration, schedules, caches, streams, HTTP clients, or tests, or when a design needs durable work, waits, fanout, workers, or persisted state and an official module may already supply it.
license: MIT
compatibility: Requires Effect v4. Examples are reviewed against the version documented in this repository.
---

# Effect

Use current Effect v4 APIs and the production defaults in this skill. Established project conventions still take precedence unless the task is explicitly changing them.

## Upstream And Project Policy

This skill uses [`kitlangton/skills`](https://github.com/kitlangton/skills) commit `30dee8607214c893dd89f6eee65c669ef3dce8c9` as its API and style baseline. The upstream files remain the primary general Effect guidance. Three owner references sit beside them: `references/VIVID.md` adds only repository integration constraints, `references/STANDARD_LIBRARY.md` preserves project-tested discovery guidance that upstream does not cover, and `references/CAPABILITIES.md` routes durable and cross-process needs to the official module to inspect.

When guidance conflicts, follow the nearest `AGENTS.md`, then the project-pinned Effect package, then this skill. Do not copy old local patterns over newer upstream APIs.

## Source Rule

Check these before guessing:

- the nearest `AGENTS.md` and any project-local Effect practices doc
- the project-pinned `effect` package source and version
- the latest official release, then unreleased `main`, of canonical `Effect-TS/effect` when the installed package does not answer the question; label which one each fact came from, and keep the installed import paths

## Branch Chooser

Read only the branch references that match the task.

- Any Effect work in Vivid: also read `references/VIVID.md`.
- Collection, record, option, result, string, or structure transformations: read `references/STANDARD_LIBRARY.md` before introducing a helper or manual loop.
- Data models, schemas, brands, variants, optional keys, or decoders: read `references/SCHEMA.md`.
- Services, module surfaces, layers, runtime wiring, errors, `Effect.fn`, or test services: read `references/SERVICES_LAYERS.md`.
- Runtime config, env variables, `ConfigProvider`, or `layerConfig`: read `references/CONFIG.md`.
- Retry, repeat, polling, backoff, jitter, rate-limit-aware policies, or pass loops: read `references/SCHEDULING.md`.
- Memoization, per-key TTL caches, deduplicating concurrent lookups, or request batching: read `references/CACHING.md`.
- Streams, event sources, async iterables, queues/pubsubs, pagination, backpressure, or stream consumers: read `references/STREAMS.md`.
- Outgoing HTTP calls, Effect HttpClient, status handling, or HTTP rate limiting: read `references/HTTP_CLIENTS.md`.
- Effect tests, time, sleeps, concurrency synchronization, or fakes: read `references/TESTING.md`.
- Architecture or a new module for durable jobs, crash replay, workflows, durable waits, realtime fanout, RPC, CPU workers, offline or persistent preferences, or transactional local state: read `references/CAPABILITIES.md` before proposing or writing custom code.

If a task spans several branches, read all matching files before editing.

## Core Defaults

- Compose workflows with `Effect.gen(function* () { ... })`.
- Define public service methods and non-trivial internal service methods with `Effect.fn("Domain.operation")`.
- Use `Effect.fnUntraced` only for internal helpers where stack-frame/span metadata is intentionally unnecessary.
- Prefer `Context.Service` for application services when the codebase has not standardized on another current service-tag style.
- Build real service implementations with `Layer.effect(Service, Effect.gen(...))` and return `Service.of({ ... })`.
- Model records with `Schema.Struct(...)` plus a same-name `interface`.
- Model typed Effect errors with `Schema.TaggedError` in the project-pinned Effect 4 API. The lock and the manifests both pin `4.0.0-rc.116`.
- Read runtime config through `Config`, not direct `process.env` access in application logic.
- Use `Schedule` for retry, repeat, polling, pacing, and backoff policies.
- Use `Stream` for effectful sources that emit many values over time and need pull, backpressure, interruption, or transformation.
- Prefer Effect HTTP client modules for outgoing HTTP in Effect applications when their typed errors, layers, and client transforms are useful.
- Prefer Effect-aware tests, explicit layers, and deterministic synchronization over sleeps.
- Prefer decoders and `schema.makeEffect(...)` at untrusted boundaries; reserve throwing `schema.make(...)` for trusted construction, and never use casts to skip validation.

## Quick Selection Guide

- Ordinary object record: `Schema.Struct(...)` plus same-name `interface`.
- Scalar ID/value object: constrained branded schema.
- Internal workflow decision or state: `Data.TaggedEnum<...>` plus `Data.taggedEnum<...>()` constructors and exhaustive `$match`.
- Reusable boundary-crossing tagged variant: `Schema.TaggedStruct(...)` plus same-name `interface`.
- Boundary-crossing tagged union: `Schema.TaggedUnion(...)` with `.cases`, `.guards`, and `.match`.
- External/custom discriminator such as `type`: `Schema.Struct({ type: Schema.tag("variant"), ... })` plus `Schema.toTaggedUnion("type")` when union helpers are needed.
- Expected typed failure: `Schema.TaggedError`.
- Unknown boundary payload: `Schema.decodeUnknownEffect(...)`.
- Service boundary: `Context.Service<Service, Interface>()(...)` plus `Layer.effect(...)` plus `Service.of(...)`.
- Public or non-trivial internal service method: `Effect.fn("Domain.operation")`.
- Runtime configuration: `Config` recipes read in layers; override with `ConfigProvider` in tests.
- Event source: `Stream` consumed with `Stream.runForEach(...)` and forked with `Effect.forkScoped` in the owning layer.
- Queue-backed event source: `Queue` for the producer boundary, `Stream.fromQueue(...)` for consumers. In-memory `Queue` is right when losing the items on restart is acceptable; when the work is owed, read `references/CAPABILITIES.md`.
- Broadcast event source: `PubSub` / `Stream.fromPubSub(...)` or `SubscriptionRef` for latest-value state. Both are process-local; when subscribers in another process or after a reconnect must not miss a change, read `references/CAPABILITIES.md`.
- Polling worker: `runPass().pipe(Effect.repeat(Schedule.spaced(...)))`, with typed pass failures handled before repeat. When each pass claims owed rows (jobs, outbox, leases), read `references/CAPABILITIES.md` first.
- Retry transient operation: `Effect.retry(...)` / `Effect.retryOrElse(...)` with a bounded `Schedule`.
- Keyed lookup cache with TTL and concurrent-lookup dedupe: prefer `Cache.make(...)` / exit-aware `Cache.makeWith(...)` when their lifecycle and eviction model fit.
- Memoize a single effect result: `Effect.cached(...)` / `Effect.cachedWithTTL(...)`.
- Batch N keys into one backend call (only when a real batch endpoint exists): `Effect.request(...)` + `RequestResolver`.
- HTTP request in an Effect application: prefer Effect `HttpClient` plus request/response schema decoding.
- HTTP transient retry: `HttpClient.retryTransient(...)`.
- Time-sensitive test: `TestClock`, not real sleeping.
- Concurrent/background test synchronization: `Deferred`, `Queue`, `Latch`, `Ref`, or explicit test hooks.

## Boundary Rules

- Keep HTTP handlers thin: decode input, read context, call services, map typed errors to transport responses.
- Keep business rules in services or domain functions, not transport handlers.
- Wrap HTTP clients, SDKs, CLIs, and external integrations in named effects at adapter boundaries.
- Decode persisted rows with Schema or SQL-specific helpers when values are not trivially trusted.
- Keep provider/network calls outside authoritative database transactions.
- Catch or retry only when the current boundary has a truthful response.
- Retry only when the operation has proven idempotency.
- Let exhausted failures remain visible unless the boundary has a real fallback.

## Do Nots

- Do not use `as any`, non-null assertions, or unchecked casts to silence Effect typing problems.
- Do not introduce `Schema.Class` or `Schema.TaggedClass` as default app data-modeling patterns.
- Do not hand-roll `_tag` error classes when `Schema.TaggedError` fits.
- Do not use cause-level recovery when typed-error recovery is enough.
- Do not use `Layer.mergeAll(...)` or `provideMerge(...)` as blind make-it-compile tools.
- Do not hide required application authority, credentials, persistence, transports, or external services behind `Context.Reference` defaults.
- Do not add arbitrary `Effect.sleep(...)` to tests when a deterministic synchronization primitive is available.
- Do not hand-roll Map/TTL/prune caches or in-flight dedupe when `effect/Cache` fits.
- Do not hand-roll a job table, outbox poller, wait store, worker protocol, or preference store, and do not adopt or reject an official module by its name, before the fit check in `references/CAPABILITIES.md`.

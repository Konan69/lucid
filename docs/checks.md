# Check pipeline

Lint and typechecking must keep their existing diagnostics and file coverage while avoiding repeated work and overlapping semantic heaps.

```text
workspace source + shared rules/configs → Turbo task hash
    hit  → restore outputs and replay diagnostics
    miss → one package check at a time
```

## Design

- Keep full type-aware lint as the default. Run one cached lint task per workspace, plus a root task for tooling and infrastructure outside workspaces. Package lint runs from the repository root so root-relative overrides, plugin paths, and Tailwind inputs keep the same meaning. Lint every workspace directory, including scripts and tests, instead of only `src`.
- Keep dependency source in downstream hashes through transit tasks. Include the shared TypeScript config in check inputs, and root rules, plugin implementation, TypeScript configs, and design-style inputs in lint hashes. Successful logs must be replayed because the pre-push warning ratchets consume them.
- Cache the root TypeScript graph alongside package graphs. Retain incremental build info as outputs, including the RPC client's explicit cache location. Include shared root configuration in build hashes. Explicit root source globs must exclude dependency shims, task logs, build info, native output, and local state; otherwise running a check changes its own next hash.
- Serialize checks through Turbo. Native TypeScript uses `--checkers 1`; build-mode typechecks also use `--builders 1`. Oxlint uses one Rust worker and defaults Go lint workers to one. These settings reduce concurrent checker state without disabling diagnostics or imposing a speculative heap limit. An explicit Go worker environment setting remains available for a deliberate comparison.
- Keep automatic Turbo worktree cache sharing. Do not add a cacheDir that would disable it. Persist `.turbo/cache` in CI; no remote cache provider is configured.
- Fix commands always execute and are never cached.

## Reference and limits

The VCOS reference (`apps/web/TYPECHECK.md` and its shared/server/agent configs) splits a combined program into declaration-producing projects and checks consumers against those outputs. Separate Vivid workspace configs are not equivalent boundaries: source exports pull shared implementation into consumers, and tests import implementation across server/runtime/skills packages. The first cache/concurrency change repairs repeat runs but does not complete this graph optimization.

### Graph optimization design

Measure native build-info file lists and focused cold compiler diagnostics before changing boundaries. Prototype declaration-only contracts first, then shared clients and skills if emission remains cheap and compatible. Keep runtime source exports, strict compiler options, Effect diagnostics, and every existing test in checked graphs. Referenced declaration outputs and their build info must be restored before consumer checks; dependency source must still invalidate downstream caches.

Separate production and test ownership where integration tests pull another application's implementation into a production graph. A solution config should preserve editor and typed-lint discovery of both graphs; exclusion without a checked test project is unacceptable. Verify typed diagnostics deliberately in both production and test files. Compare cold elapsed time and peak resident memory, including declaration prerequisites, before retaining a split. Do not trade a faster leaf check for a slower full pipeline without reporting it.

Contracts, RPC, state, skills, and runtime now have declaration projects. Their solution configs also include separate test projects where tests exist. Turbo's `types` task caches declarations and build info before lint/typecheck consumers run. Runtime integration tests intentionally keep their server fixture imports in a no-emit test graph; the production project excludes tests. Relative imports between server/runtime/skills, and mobile's imports of web library code, have explicit check-task cache edges. These edges target production types or source-input transit tasks, avoiding a cycle between skills tests and runtime production.

Runtime source exports remain available to application bundlers. Consumers reference declaration projects without preferring implementation source. Expo retains its base config and explicitly excludes generated build/cache/native directories. Skills' Markdown adapter names Flue's private result through `ReturnType<typeof parseSkillMarkdown>` so declarations preserve the upstream type without importing a private interface.

A whole-server declaration prototype exposed Better Auth portability errors and integration fixture imports; that prototype is not part of this change. The server retains one checked source/test project and consumes the shared declaration projects.

VCOS also has a machine-wide queue for heavy work. Turbo concurrency limits apply to one invocation, not to every session on a machine. Vivid's existing Cloudbox policy still applies to heavy gates. This change does not control unrelated jobs.

The observed tsgolint allocation was approximately 3.6 GiB of private resident memory. The installed engine creates four compiler checker instances by default. Its lint-worker setting is independent of Oxlint's Rust worker count. Lowering Go lint workers limits active semantic work but does not remove the four-instance compiler pool. Worker limits retain the full compiler pool; measured savings come from limiting active semantic work and resetting each package process.

## Measurements

On the same 4-core, 8-GiB idle Cloudbox and source snapshot (base `133644c3`), GNU time measured:

| Lint invocation                                | Peak process RSS | Wall time |
| ---------------------------------------------- | ---------------: | --------: |
| Former whole-workspace `oxlint --type-aware .` |         4.21 GiB |    9.56 s |
| New package pipeline, forced cache misses      |         1.65 GiB |   21.57 s |

Peak process RSS fell 60.7%. The fully uncached pipeline trades elapsed time for lower CPU and memory pressure; subsequent checks reuse unchanged package results. These are individual-process peaks, not aggregate machine memory, and a single controlled comparison, not a universal heap bound. Both commands kept full type-aware rules and exited successfully. Each checked 967 files and produced the same 15 diagnostic messages at the same file positions.

## Verification

Validate task coverage and shared-input invalidation with Turbo dry runs. Use a small isolated cache probe to verify reuse, diagnostic replay, and output restoration without launching repository type graphs. Test lint invocation scope, worker settings, failure propagation, and fix behavior through its CLI seam. Run the finishing gate on an available Cloudbox, keeping it isolated from live data and other workloads.

On 5 October 2026, the finishing gate for implementation `7a54f68d` (rebased onto `7d572ac1`) passed on an isolated Cloudbox: 66 tooling tests and 1,179 application tests passed. The 824 database/live tests skipped without test authority or credentials. Lint ratchets, formatting, all 13 typechecks, policy checks, and audits passed.

After the gate, all 27 real lint/typecheck/format tasks reported cache hits. A warm `pnpm lint` replayed all 13 lint results in 0.30 seconds with 114 MiB peak process RSS. Focused regressions verify that generated workspace files do not invalidate root tasks, alongside dependency invalidation and build-info restoration.

The subsequent declaration split adds five real declaration tasks. Its 13 focused tooling tests pass, including real-compiler production/test/consumer error detection, declaration restoration, and integration-source invalidation. Focused declaration checks pass for all five producers, and focused checks pass for all four test projects. Runtime typed lint discovers both production and test configs and passes. Its test program contains 1,883 files versus 2,163 in the former combined program; production is checked separately, so this count is not a memory or timing measurement.

Full-gate validation and a controlled cold comparison for this subsequent split are still pending. On 5 October the Vivid Cloudbox was stuck provisioning, while Konan reported load 232 on four CPUs during another Android build. Heavy checks stay deferred under `AGENTS.md`; no new speedup or overall memory bound is established for the split yet.

Primary references: [Turbo caching](https://github.com/vercel/turborepo/blob/v2.11.2/apps/docs/content/docs/crafting-your-repository/caching.mdx), [native checker pool](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/compiler/checkerpool.go), [tsgolint worker loop](https://github.com/oxc-project/tsgolint/blob/acd88e1b1ef8f219e8956f804f2548dafd949705/internal/linter/linter.go).

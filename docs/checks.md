# Check pipeline

Lint and typechecking must keep their existing diagnostics and file coverage while avoiding repeated work and overlapping semantic heaps.

```text
workspace source + shared rules/configs → Turbo task hash
    hit  → restore outputs and replay diagnostics
    miss → one package check at a time
```

## Design

- Keep full type-aware lint as the default. Run one cached lint task per workspace, plus a root task for tooling and infrastructure outside workspaces. Package lint runs from the repository root so root-relative overrides, plugin paths, and Tailwind inputs keep the same meaning. Lint every workspace directory, including scripts and tests, instead of only `src`.
- Typed lint has no declaration prerequisite. The pinned tsgolint program constructor sets `UseSourceOfProjectReference: true`, independently of consumers' declaration redirects. Emitting five declaration projects before lint therefore adds work without reducing its programs. Keep source-input cache edges for ordinary dependencies and relative integration imports; declaration tasks remain prerequisites of native typechecking.
- Keep dependency source in downstream hashes through transit tasks. Include the shared TypeScript config in check inputs, and root rules, plugin implementation, TypeScript configs, and design-style inputs in lint hashes. Successful logs must be replayed because the pre-push warning ratchets consume them.
- Cache the root TypeScript graph alongside package graphs. Retain incremental build info as outputs, including the RPC client's explicit cache location. Include shared root configuration in build hashes. Explicit root source globs must exclude dependency shims, task logs, build info, native output, and local state; otherwise running a check changes its own next hash.
- Serialize checks through Turbo. Native TypeScript uses `--checkers 1`; build-mode typechecks also use `--builders 1`. Oxlint uses one Rust worker and defaults Go lint workers to one. These settings reduce concurrent checker state without disabling diagnostics or imposing a speculative heap limit. An explicit Go worker environment setting remains available for a deliberate comparison.
- Run cached declaration and typecheck tasks in project mode through `scripts/types.mjs`. Turbo prepares referenced declarations first; project mode compares file contents against incremental data on a cache miss. Build mode can wrongly skip a changed source file whose timestamp predates restored output. Direct package commands use a forced, serialized build so their references are prepared without Turbo. Split packages check production through `types` and tests through `typecheck`; RPC has no test project and rechecks its declaration project.
- Keep automatic Turbo worktree cache sharing. Do not add a cacheDir that would disable it. Persist `.turbo/cache` in CI; no remote cache provider is configured.
- Fix commands always execute and are never cached.

## Reference and limits

The VCOS reference (`apps/web/TYPECHECK.md` and its shared/server/agent configs) splits a combined program into declaration-producing projects and checks consumers against those outputs. Separate Vivid workspace configs are not equivalent boundaries: source exports pull shared implementation into consumers, and tests import implementation across server/runtime/skills packages. The first cache/concurrency change repairs repeat runs but does not complete this graph optimization.

### Graph optimization design

Measure native build-info file lists and focused cold compiler diagnostics before changing boundaries. Prototype declaration-only contracts first, then shared clients and skills if emission remains cheap and compatible. Keep runtime source exports, strict compiler options, Effect diagnostics, and every existing test in checked graphs. Referenced declaration outputs and their build info must be restored before consumer checks; dependency source must still invalidate downstream caches.

Separate production and test ownership where integration tests pull another application's implementation into a production graph. A solution config should preserve editor and typed-lint discovery of both graphs; exclusion without a checked test project is unacceptable. Verify typed diagnostics deliberately in both production and test files. Compare cold elapsed time and peak resident memory, including declaration prerequisites, before retaining a split. Do not trade a faster leaf check for a slower full pipeline without reporting it.

Contracts, RPC, state, skills, and runtime now have declaration projects. Their solution configs also include separate test projects where tests exist. Turbo's `types` task caches declarations and build info before native typecheck consumers run. Typed lint instead loads reference source and depends only on source-input transit tasks. Runtime integration tests intentionally keep their server fixture imports in a no-emit test graph; the production project excludes tests. Relative imports between server/runtime/skills, and mobile's imports of web library code, have explicit check-task cache edges. These edges target production types or source-input transit tasks, avoiding a cycle between skills tests and runtime production.

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

### Why cold lint regressed

The first comparison used about 304% CPU for the former command and 112% for the serialized package pipeline. Limiting both Rust workers and Go lint workers to one removed most of the former parallelism. Thirteen process launches also repeat plugin setup, config discovery, and compiler program creation. tsgolint creates fresh programs rather than reusing native typecheck build info, and referenced shared source can occur in several programs. Turbo reuses completed tasks; it does not share a live compiler heap between cache misses.

Inspection of the exact tsgolint 7.0.2002 release found that declaration outputs cannot reduce its referenced-source programs. Lint no longer runs the five declaration producers. This removes unnecessary cold compiler starts and stops typecheck-runner changes from invalidating lint. The native TypeScript declaration boundaries remain useful to native typechecking; their effect cannot be assumed for typed lint.

On the upgraded Konan box (eight CPUs, roughly 16 GiB), exploratory direct package runs compared the same source/configuration with different Go worker counts:

| Go lint workers | Wall time | Sampled peak total child RSS | Sampled largest child RSS |
| --------------: | --------: | ---------------------------: | ------------------------: |
|               1 |   25.16 s |                     2.18 GiB |                  1.78 GiB |
|               2 |   21.40 s |                     2.45 GiB |                  2.05 GiB |

Both runs produced the same 16 complete diagnostic records. Total RSS sums descendants at 100 ms intervals and may count shared pages more than once; it differs from GNU time's maximum individual-process RSS. These trials had an active emulator/capture workload and used the owned validation copy before removal of two obsolete files. They are evidence of the speed/memory tradeoff, not a controlled idle-machine speedup. Keep the default at one worker and retain the explicit override until an idle comparison justifies a different default.

A first post-reboot run took 223.7 seconds but accumulated only 36.2 CPU seconds and 2,377 major page faults. Its 16% CPU utilization shows substantial waiting; freshly resumed storage and changed background work confound that timing. An earlier interrupted run crossed a reboot and was discarded. Do not compare these filesystem and machine states as compiler speed measurements.

## Verification

Validate task coverage and shared-input invalidation with Turbo dry runs. Use a small isolated cache probe to verify reuse, diagnostic replay, and output restoration without launching repository type graphs. Test lint invocation scope, worker settings, failure propagation, and fix behavior through its CLI seam. Run the finishing gate on an available Cloudbox, keeping it isolated from live data and other workloads.

On 5 October 2026, the finishing gate for the declaration split, content-aware check runner, and declaration-free lint prerequisites passed on Konan: 72 tooling tests and 1,179 application tests passed. The 824 database/live tests skipped without test authority or credentials. Lint ratchets, formatting, all 13 typechecks, policy checks, and audits passed. The owned invocation used two CPUs at low priority alongside the running emulator; unrelated processes were not changed.

The gate took 149.49 seconds and peaked at 2.35 GiB sampled total child RSS. All 13 lint tasks were cache misses and completed in 23.81 seconds. The 18 declaration/typecheck tasks completed in 6.41 seconds with 11 cache hits, so this is not a fully cold native typecheck measurement. These timings reflect an active shared machine and cannot establish an idle-machine speedup.

After the gate, all 32 real lint/declaration/typecheck/format tasks reported cache hits. Actual warm commands replayed all 13 lint results in 0.38 seconds and all 18 declaration/typecheck results in 0.26 seconds, each using approximately 110 MiB peak process RSS. Focused regressions verify that generated workspace files do not invalidate root tasks, alongside dependency invalidation and build-info restoration.

The subsequent declaration split adds five real declaration tasks. Its 16 focused tooling tests cover real-compiler production/test/consumer error detection, declaration restoration, and integration-source invalidation. A subsequent cache probe reproduced a false success in native build mode: a deliberately invalid source older than cached output was considered up to date. The check runner fixes this with project mode inside Turbo and forced build mode for direct commands. The real Turbo/native regression restores cached declarations, changes production, test, and consumer files with older timestamps, and requires each error to fail. Runner changes also invalidate declaration and consumer check hashes. A real pinned-Oxlint regression requires semantic lint errors in production, tests, and consumers with no emitted declarations, and a real Turbo probe verifies all 13 lint tasks run without declaration producers.

Focused declaration checks pass for all five producers, and focused checks pass for all four test projects. Runtime typed lint discovers both production and test configs and passes. Its test program contains 1,883 files versus 2,163 in the former combined program; production is checked separately, so this count is not a memory or timing measurement.

A controlled, fully cold native typecheck comparison for the declaration split remains unmeasured. The successful full gate establishes correctness and cache reuse; it does not establish a new overall memory bound or cold typecheck speedup.

Primary references: [Turbo caching](https://github.com/vercel/turborepo/blob/v2.11.2/apps/docs/content/docs/crafting-your-repository/caching.mdx), [Turbo task environment](https://turborepo.dev/docs/reference/system-environment-variables), [TypeScript build timestamps](https://www.typescriptlang.org/docs/handbook/project-references.html), [native checker pool](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/compiler/checkerpool.go), [tsgolint worker loop](https://github.com/oxc-project/tsgolint/blob/acd88e1b1ef8f219e8956f804f2548dafd949705/internal/linter/linter.go), [pinned tsgolint program constructor](https://github.com/oxc-project/tsgolint/blob/acd88e1b1ef8f219e8956f804f2548dafd949705/internal/utils/create_program.go).

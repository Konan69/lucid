# Check pipeline

Lint and typechecking must keep their existing diagnostics and file coverage while avoiding repeated work and overlapping semantic heaps.

```text
workspace source + shared rules/configs → Turbo task hash
    hit  → restore outputs and replay diagnostics
    miss → one package check at a time
```

## Design

- Keep full type-aware lint as the default. Run one cached lint task per workspace, plus a root task for tooling and infrastructure outside workspaces. Package lint runs from the repository root so root-relative overrides, plugin paths, and Tailwind inputs keep the same meaning. Lint every workspace directory, including scripts and tests, instead of only `src`.
- Typed lint has no declaration prerequisite. The pinned tsgolint program constructor sets `UseSourceOfProjectReference: true`, but still honors `disableSourceOfProjectReferenceRedirect`. Leave source redirects enabled so a fresh checkout resolves shared imports before any declaration emission. Native CLI consumers still use referenced declarations; a real compiler file-list regression verifies that boundary. Emitting five declaration projects before lint therefore adds work without reducing its programs. Keep source-input cache edges for ordinary dependencies and relative integration imports; declaration tasks remain prerequisites of native typechecking.
- Keep dependency source in downstream hashes through transit tasks. Include the shared TypeScript config in check inputs, and root rules, plugin implementation, TypeScript configs, and design-style inputs in lint hashes. Successful logs must be replayed because the pre-push warning ratchets consume them.
- Separate full owner inputs (`checkinputs`) from dependency production inputs (`typeinputs`). Only the five composite declaration owners exclude `src/**/*.test.ts`, `src/**/*.test.tsx`, and `tests/**` from production hashes; their typechecks and lints still hash those files. Other packages retain full dependency inputs, and explicit integration edges retain fixture/test inputs. A shared test edit must rerun its owner without rebuilding declarations and every application consumer.
- Cache the root TypeScript graph alongside package graphs. Retain incremental build info as outputs, including the RPC client's explicit cache location. Include shared root configuration in build hashes. Explicit root source globs must exclude dependency shims, task logs, build info, native output, and local state; otherwise running a check changes its own next hash.
- Serialize checks through Turbo. Native TypeScript uses `--checkers 1`; build-mode typechecks also use `--builders 1`. Oxlint uses one Rust worker and defaults Go lint workers to one. These settings reduce concurrent checker state without disabling diagnostics or imposing a speculative heap limit. An explicit Go worker environment setting remains available for a deliberate comparison.
- Run cached declaration and typecheck tasks in project mode through `scripts/types.mjs`. Turbo prepares referenced declarations first; project mode compares file contents against incremental data on a cache miss. Build mode can wrongly skip a changed source file whose timestamp predates restored output. Direct package commands use a forced, serialized build so their references are prepared without Turbo. Split packages check production through `types` and tests through `typecheck`; RPC has no test project and rechecks its declaration project.
- Keep automatic Turbo worktree cache sharing. Do not add a cacheDir that would disable it. Persist `.turbo/cache` in CI; no remote cache provider is configured.
- Fix commands always execute and are never cached.

## The gate

`pnpm gate` (`scripts/gate.mjs`) is the one definition of the checks. Its stages are in `scripts/gate/stages.mjs`, the lint ratchets in `scripts/gate/ratchets.mjs`; the push hook, a run on another machine and each GitHub job select stages from it.

```text
policy (5 checks, together, always run)
checks lane: lint, format, typecheck, tooling tests   one Turbo task at a time
tests lane:  test per package                         beside the checks lane
```

- Tests run through Turbo, one task per package. A test task hashes its package, its dependencies' production source (`checkinputs`), the explicit integration edges, and every test setting except the database address; it needs no build. A package nothing reached is replayed with its counts, so the verdict always reports the whole suite.
- A task for one package replaces the generic task, and so does a package's own `turbo.json`; Turbo merges neither. Each such task repeats the generic inputs, outputs and environment, and `scripts/gate.test.mjs` fails when one drifts. Before this, the server, runtime, skills and mobile lint did not rerun when the lint configuration changed.
- Every run creates one empty database and gives it to the suites. The server's migrated template is named by a digest of the migrations and kept on the test server; each test file clones it under the run's prefix, and the run drops everything with its prefix at the end. Without a database server the gate fails.
- `--host` runs in a warm tree on another machine: a worktree per branch of one repository there, moved by git, with dependencies and build info kept and one Turbo cache for all trees. The client follows the run by its identifier.
- At most one gate per four cores does work at once on a machine, across checkouts. Lint and typecheck stay serialized as designed above; the measured peak for one typed lint process is still about 3.6 GiB.
- `affected` gives each package's Vitest the commit where the branch left the default branch (`--changed`), so only test files whose imports reach a changed file run. A file a test reads without importing is outside that graph; the full gate is the merge gate.

### Which test files run

"Run only the tests that changed" cannot mean the test files that were edited: a test's result changes when anything it loads changes. So each package's test script is `scripts/test.mjs`, and a test file runs only when its inputs differ from the last time it passed.

- A file's key is the content of every module it loads, read from Vitest's own transform of each module (static and dynamic imports as Vite resolved them, so path aliases, package exports and Flue's Markdown imports are followed exactly as the run follows them), plus the package's inputs: the lockfile, the compiler and runner configuration, the setup files and what they load, the test settings in the environment, and every tracked file in the package that is not code (fixtures, migrations, Markdown read from disk).
- A file whose key already passed is replayed with its counts, so the verdict still reports the whole suite. A failed file is never recorded.
- An import graph cannot see everything. A module that starts another program, reads files by its own location or the working directory, imports a computed path, or loads modules by its own means makes every test that reaches it "wide": that test is keyed on Turbo's hash of the whole package task and runs whenever anything in the package or its dependencies changed. Test code that touches the file system at all is wide too. `node scripts/test.mjs --plan` in a package lists the wide files and the reason for each. In the server package 27 of 168 files are wide.
- A type-only change runs no test: erased imports are not in the graph, and typecheck is the stage that owns types.
- `--all` (or `VIVID_TEST_ALL=1`) runs every file and trusts no record. GitHub's job for the default branch does that, so a dependency the keys miss is caught there at the latest.
- The records are small files named by key, shared by every checkout on a machine through the gate's cache directory.

On a remote machine the gate keeps one warm tree per concurrent gate (one for every four cores) and takes the first free one, whatever the branch; it writes a `.boxignore` beside them so a Boat machine does not snapshot dependency trees or caches. One tree per branch, without that file, filled a machine's disk in a day.

Measured on the eight-core Cloudbox on 6 October 2026, same repository state, other threads' gates running beside it:

| Run                                               |                                               Before |                                                           After |
| ------------------------------------------------- | ---------------------------------------------------: | --------------------------------------------------------------: |
| Full gate, nothing changed                        | 7 min (fresh tree, 0 cached, queued behind one lock) |                  4 to 17 s from command (all 53 tasks replayed) |
| Full gate after a server source change            |                                                7 min |                                         56 to 88 s from command |
| Named test files with the database                |                                         not possible |                                               10 s from command |
| Two full gates at once, each with a server change |                           second waits for the first |                                   both pass, 88 s each, no wait |
| Server suite alone (164 files)                    |                                 226 s at two workers | 134 s at four workers under load; about 60 s on a quiet machine |

A tree with a deliberate lint finding, type error, format error and failing test fails in exactly those four stages. The old hook's serial sequence, run against the new tree, also passes.

## Effect language service

Typecheck runs the native TypeScript 7 compiler. `effect-language-service patch` patches the JavaScript `typescript` package, which typecheck does not run, so from the move to TypeScript 7 until 7 October 2026 no Effect diagnostic reached the gate: a floating Effect and a `new Promise` in a contracts file passed typecheck. `@effect/tsgo` is the service for the native compiler (its README: "If you are using TypeScript 7.0 or newer, use `@effect/tsgo`"); `prepare` now runs `effect-tsgo patch --typescript` as well, and the plugin block in `tsconfig.base.json` is read by both.

The first patched run reported 1,677 findings that had gathered meanwhile, none of them a plain TypeScript error: 741 `strictEffectProvide` (most are tests that give a Layer to each case with `Effect.provide` where `layer(...)` builds it once for the file), 406 `unnecessaryFailYieldableError`, 188 `schemaNumber`, 84 `asyncFunction`, 52 `multipleEffectProvide`, and 29 smaller rules. For now the compiler prints every finding and exits 0 (`ignoreEffect...InTscExitCode`), and the gate's typecheck line says how many there are without failing. They are being fixed on their own branch; when the count is zero the options go back to `false`, so an Effect error or warning fails typecheck again, and `scripts/versions.mjs` goes back to requiring that.

## The type checker is ts-rust

Since 7 October 2026 `scripts/types.mjs` runs `tsc-rs` 0.1.0 (pingdotgg/ts-rust), a Rust port of the native TypeScript compiler with the same command line, declarations and build info, and the Effect language service rules built in. `@typescript/native` 7.0.2 stays installed: typed lint and editors use it, `@effect/tsgo` patches it, and `apps/web`'s build compiles with it. `tsc-rs` runs on Linux x64 and macOS arm64 only.

Measured on the PC over the gate's whole typecheck graph (17 projects, in dependency order, declarations included, Effect rules on, cold):

| Compiler                                             |   Time | Peak memory, largest process | Diagnostics                               |
| ---------------------------------------------------- | -----: | ---------------------------: | ----------------------------------------- |
| native `tsc` 7.0.2, one checker (the gate until now) | 28.3 s |                      1.97 GB | 1,677 Effect findings, 0 errors           |
| native `tsc` 7.0.2, default checkers                 | 19.1 s |                      3.08 GB | the same                                  |
| `tsc-rs` 0.1.0                                       | 11.1 s |                      2.07 GB | the same 1,677, and 3 errors more (below) |

The server project alone: 14.2 s, 8.1 s and 5.2 s. Warm, with build info kept: 8.8 s native, 4.1 s `tsc-rs`.

The 3 extra errors were TS7031 (implicit any) on `packages/agent/runtime/src/tools/sandbox.ts`, for `(path, { recursive } = {}) =>` in an object typed by an SDK interface. They are not a fault of the port: TypeScript 6.0.3, 7.0.2 and the 7.1 nightly of 22 September accept the code, and the nightly of 23 September and later report the same error, since microsoft/TypeScript pull request 64043 ("Align object binding defaults with arrays"). The compiler says the element is implicitly `any` while its own next diagnostic gives its type as `boolean | undefined`. The two parameters are annotated in `sandbox.ts` until that is fixed; pingdotgg/ts-rust issue 16 and pull request 17 carry the reproduction and a fix (report the error only when the parameter has no contextual type).

## Reference and limits

The VCOS reference (`apps/web/TYPECHECK.md` and its shared/server/agent configs) splits a combined program into declaration-producing projects and checks consumers against those outputs. Separate Vivid workspace configs are not equivalent boundaries: source exports pull shared implementation into consumers, and tests import implementation across server/runtime/skills packages. The first cache/concurrency change repairs repeat runs but does not complete this graph optimization.

### Graph optimization design

Measure native build-info file lists and focused cold compiler diagnostics before changing boundaries. Prototype declaration-only contracts first, then shared clients and skills if emission remains cheap and compatible. Keep runtime source exports, strict compiler options, Effect diagnostics, and every existing test in checked graphs. Referenced declaration outputs and their build info must be restored before consumer checks; dependency source must still invalidate downstream caches.

Separate production and test ownership where integration tests pull another application's implementation into a production graph. A solution config should preserve editor and typed-lint discovery of both graphs; exclusion without a checked test project is unacceptable. Verify typed diagnostics deliberately in both production and test files. Compare cold elapsed time and peak resident memory, including declaration prerequisites, before retaining a split. Do not trade a faster leaf check for a slower full pipeline without reporting it.

Contracts, RPC, state, skills, and runtime now have declaration projects. Their solution configs also include separate test projects where tests exist. Turbo's `types` task caches declarations and build info before native typecheck consumers run. Typed lint instead loads reference source and depends only on source-input transit tasks. Runtime integration tests intentionally keep their server fixture imports in a no-emit test graph; the production project excludes tests. Relative imports between server/runtime/skills, and mobile's imports of web library code, have explicit check-task cache edges. These edges target production types or source-input transit tasks, avoiding a cycle between skills tests and runtime production.

Runtime source exports remain available to application bundlers. Native CLI consumers read referenced declarations; editor and typed-lint programs may redirect to implementation source. Expo retains its base config and explicitly excludes generated build/cache/native directories. Skills' Markdown adapter names Flue's private result through `ReturnType<typeof parseSkillMarkdown>` so declarations preserve the upstream type without importing a private interface.

The RPC client service uses a named interface extending its existing schema-derived mapped client type. With a type alias, native declaration emission expanded every method inside the Context.Service base class: 6,020 lines. The named interface retains the same RPC methods, payloads, results, and error channels while emitting 63 lines. Runtime construction is unchanged.

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

### Native typechecking

Konan comparisons removed every owned declaration and build-info output and forced every Turbo typecheck task to execute. They included the root check and all declaration prerequisites, used two CPUs at low priority, and kept the emulator running. Filesystem page cache was left intact; these are compiler/cache-cold runs, not cold-disk measurements. The first two rows used identical application source with different check configurations. The final row also changes the RPC service's equivalent type representation.

| Native pipeline                                              | Real tasks | Wall time | User + system CPU time | GNU peak process RSS |
| ------------------------------------------------------------ | ---------: | --------: | ---------------------: | -------------------: |
| Serialized pipeline before declaration split (`7a54f68d`)    |         13 |   11.63 s |                15.57 s |             1.59 GiB |
| Initial declaration split and cache-safe runner (`2bcf0565`) |         18 |   12.74 s |                17.94 s |             1.67 GiB |
| Named RPC interface and production/test cache inputs         |         18 |   12.08 s |                16.74 s |             1.61 GiB |

All three runs passed with zero Turbo cache hits. The split initially regressed cold time and global peak memory. Named RPC declarations recovered part of that cost; the final cold run remains slightly slower than the prior serialized pipeline. These are single observations on a shared machine, not a statistically controlled speedup or universal memory bound.

Server checking remains the largest native program. Initial splitting reduced its file count from 3,623 to 3,607 but increased parsed lines from 915,090 to 941,467 and type instantiations from 4,761,039 to 4,876,371. Larger generated declarations explain why a smaller source-file count did not establish a smaller semantic heap. Production/test boundaries reduce repeated implementation checking in several consumers, but the server graph still determines the overall peak.

A real dry-run probe changed only `contracts/src/signin.test.ts`. Previously it invalidated 15 native tasks, including all five declaration producers and application consumers. Production/test input separation reduces this to the contracts test check and the conservative root check: two tasks. An actual check after appending a comment to that test completed in 0.74 seconds with 16 of 18 cache hits; all declaration producers and application checks were reused. An unchanged run hit all 18 entries in 0.32 seconds with approximately 111 MiB sampled largest-child RSS. Real compiler regressions also require an invalid test to fail while its production declarations replay from cache. Production edits and explicit relative integration inputs still invalidate consumers.

## Verification

Validate task coverage and shared-input invalidation with Turbo dry runs. Use a small isolated cache probe to verify reuse, diagnostic replay, and output restoration without launching repository type graphs. Test lint invocation scope, worker settings, failure propagation, and fix behavior through its CLI seam. Run the finishing gate on an available Cloudbox, keeping it isolated from live data and other workloads.

On 5 October 2026, the finishing gate including the named RPC interface and production/test cache inputs passed on Konan: 73 tooling tests and 1,179 application tests passed. The 824 database/live tests skipped without test authority or credentials. Lint ratchets, formatting, all 13 typechecks, policy checks, and audits passed. The owned invocation used two CPUs at low priority alongside the running emulator; unrelated processes were not changed.

The gate took 127.70 seconds and peaked at 2.32 GiB sampled total child RSS. Lint completed in 17.51 seconds with nine cache misses and four hits. The 18 declaration/typecheck tasks completed in 4.98 seconds with zero Turbo hits but existing compiler incremental data; this is not a fully cold native typecheck measurement. These timings reflect an active shared machine and cannot establish an idle-machine speedup.

Before the native follow-up, all 32 real lint/declaration/typecheck/format tasks reported cache hits. Actual warm commands replayed all 13 lint results in 0.38 seconds and all 18 declaration/typecheck results in 0.26 seconds, each using approximately 110 MiB peak process RSS. Focused regressions verify that generated workspace files do not invalidate root tasks, alongside dependency invalidation and build-info restoration.

The subsequent declaration split adds five real declaration tasks. Its 17 focused tooling tests cover real-compiler production/test/consumer error detection, declaration restoration, integration-source invalidation, and test-only production-cache reuse. A subsequent cache probe reproduced a false success in native build mode: a deliberately invalid source older than cached output was considered up to date. The check runner fixes this with project mode inside Turbo and forced build mode for direct commands. The real Turbo/native regression restores cached declarations, changes production, test, and consumer files with older timestamps, and requires each error to fail. Runner changes also invalidate declaration and consumer check hashes. A real pinned-Oxlint regression first requires valid imported types to resolve without emitted declarations, then requires floating promises from imported functions to fail in production, tests, and consumers. A real Turbo probe verifies all 13 lint tasks run without declaration producers. The fresh merged checkout exposed that disabling editor source redirects also prevented tsgolint from resolving shared imports; removing that flag fixes cold lint while native CLI consumers retain declaration boundaries.

Focused declaration checks pass for all five producers, and focused checks pass for all four test projects. Runtime typed lint discovers both production and test configs and passes. Its test program contains 1,883 files versus 2,163 in the former combined program; production is checked separately, so this count is not a memory or timing measurement.

The native measurements above establish a complete compiler/cache-cold comparison under the recorded resource limits. A quiet-machine comparison remains unmeasured, and the measured result does not establish an overall cold speedup over the prior serialized pipeline.

Primary references: [Turbo caching](https://github.com/vercel/turborepo/blob/v2.11.2/apps/docs/content/docs/crafting-your-repository/caching.mdx), [Turbo task environment](https://turborepo.dev/docs/reference/system-environment-variables), [TypeScript build timestamps](https://www.typescriptlang.org/docs/handbook/project-references.html), [native checker pool](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/compiler/checkerpool.go), [tsgolint worker loop](https://github.com/oxc-project/tsgolint/blob/acd88e1b1ef8f219e8956f804f2548dafd949705/internal/linter/linter.go), [pinned tsgolint program constructor](https://github.com/oxc-project/tsgolint/blob/acd88e1b1ef8f219e8956f804f2548dafd949705/internal/utils/create_program.go).

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

The VCOS reference splits a combined client/server/runtime program into declaration-producing projects and checks them sequentially. Vivid already has separate workspace graphs; the immediate gaps are repeated uncached lint, missing shared cache inputs, and multiple native checker instances. A declaration-boundary migration would change package exports and requires its own measurements and compatibility work; it is not necessary to repair this pipeline.

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

Primary references: [Turbo caching](https://github.com/vercel/turborepo/blob/v2.11.2/apps/docs/content/docs/crafting-your-repository/caching.mdx), [native checker pool](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/compiler/checkerpool.go), [tsgolint worker loop](https://github.com/oxc-project/tsgolint/blob/acd88e1b1ef8f219e8956f804f2548dafd949705/internal/linter/linter.go).

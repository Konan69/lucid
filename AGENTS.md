# Vivid agent instructions

## Session rules

- Be concise with the user. Take the next safe, non-destructive step without waiting for permission, and keep moving until the task is complete or a real blocker appears.
- Read the nearest `AGENTS.md`, relevant code, and matching skill before changing an unfamiliar surface. When a reference implementation exists on disk, trace its domain state, control flow, prompts, failure handling, and UI behavior before designing; state any part that cannot be inspected.
- When delegating, verify the available provider/model identifier and set it explicitly. Prefer an economical model for bounded work and a stronger model only when the work needs it; cost matters. Give distinct file ownership when agents work concurrently. The primary agent reviews every change and verifies the combined result before accepting it.
- Keep changes narrow and production-ready. Never use `git stash`; several contributors may share a branch and a stash hides work. Stage explicit paths and make focused commits after each major concern.
- Use pnpm only. Never write commands for another JavaScript package manager in scripts, hooks, CI, documentation, skills, or agent guidance. Keep `packageManager`, `engines.pnpm`, workspace settings, CI, and the lockfile aligned.
- Prefer `rg` for search. Preserve method receivers: call `object.method(...)`; never call a destructured method loose unless it is explicitly bound.

## The three ways to hurt yourself

1. **Killing by pattern.** Never use `pkill -f`, `pgrep | kill`, or kill a PID found by matching a name, path, command, or worktree string. A `pkill -f <pattern>` matched the invoking agent's own command line in this repository today. Kill only a PID captured when you spawned the process, or the owner of your port after confirming that process belongs to this worktree.
2. **Writing to live data.** The developer's real local database and volumes are read/copy only: the `vivid` PostgreSQL instance on port 55433, Alchemy `.alchemy` state, and `packages/agent-runtime/.state`. Never point tests, migrations, cleanup, or fixtures at them. Tests use an isolated disposable database supplied only through `VIVID_TEST_DATABASE_URL`.
3. **Baking in origins.** Development is single-origin through the Vite proxy. Never bake a `localhost` URL, service origin, or runtime token into a client bundle; doing so breaks remote access and exposes runtime authority.

## Engineering standard

No overengineering means no speculative abstraction, indirection, or plumbing you do not yet need — it does **not** mean skimping on rigor. Always model the domain first: strong types, Effect `Schema` contracts, branded identifiers, and tagged variants are the baseline, never the “complex” option. “Simplest” means the simplest design that keeps the model honest, not the fewest keystrokes. Do not cite simplicity to avoid a schema, precise failure, or exhaustive state model.

Product feel matters. Keep Vivid fast, snappy, and local-first. Prefer caching, preloading, optimistic updates, and reuse of warm UI/runtime state so people rarely see avoidable loading states.

Minimal correct code wins. Solve the actual problem with the fewest concepts, indirections, and lines that preserve an honest model. Consolidate before adding. Delete wrappers that only rename a standard combinator or preserve obsolete architecture. Concise is not terse: precise types and explanatory comments still apply.

Complexity is linted: classic cyclomatic complexity 12, 120 lines per function, nesting depth 3, four parameters, three nested callbacks. A finding means the function owns more than one decision; split the variant or extract the pure step rather than flattening syntax to pass. Existing findings are ratcheted in `.husky/pre-push` and may only go down.

Keep one responsibility per module. Split files that own unrelated concerns. Pure domain logic must be testable without booting a server, database, Flue runtime, Expo runtime, or browser.

Keep one source of truth for each vocabulary, invariant, and mapping. Derive dependent values so extending the source makes missing cases fail at typecheck. Where direct derivation is blocked, keep one declaration authoritative and assert total coverage of the other at the type level; never cast to force agreement.

## Taste

Keep complexity at the adapter boundary, orchestration pure, and UI dumb. Prefer inferred types over annotations when inference preserves the full domain contract. Do not add continuously repainting animations; they waste power and drop frames on high-refresh displays. If a rule fights the task, say so loudly and get human sign-off before breaking it.

## Domain honesty

Production code starts with the domain model, not plumbing. Decode unknown data once at its ingress, then keep it typed. Do not use `any`, pass-through `unknown`, non-null assertions, `?? null`, `?? ""`, `?? new Date()`, broad recovery, or optional-chaining walks to make a dishonest model compile.

Errors are part of the domain model. Failures that demand different handling need different tags with branded domain context. Never use one catch-all error discriminated by a free-form message or code string.

For closed Effect 4 states, prefer `Schema.TaggedUnion` and its generated `.cases`, `.guards`, `.isAnyOf`, and exhaustive `.match` helpers. Construct variants with the case schema's `.make`; do not recreate the state machine with raw discriminator comparisons, object literals, nested booleans, or duplicated readiness predicates. These names are verified against the pinned Effect `4.0.0-rc.116` source; re-check installed source when the pin changes.

Keep identity, tenancy, and attribution separate. A **Person** is the human actor. A **Company** plus **Membership** defines tenancy and permissions. **Vivid** is the product actor. A **Thread** is the collaboration boundary and a **Run** is one bounded attempt inside it. Do not smuggle Person ids into Company identity, runtime identity, connection identity, storage keys, or attribution fields.

Avoid fallback-driven design. Do not invent fake titles, prompts, identities, timestamps, empty strings, “best effort” branches, aliases, or broad lookups to keep broken state limping. If a required relation is absent, return a typed error and fix the caller or model.

Optional and nullable fields are allowed only when the domain genuinely has absence. If code asks “when this optional exists, is this really a different thing?”, replace the bag with a tagged variant or `Option`. Avoid optional parameters on internal domain functions; prefer explicit input variants or separate functions.

Construct domain values explicitly at boundaries. Avoid conditional object spreads, nested ternaries, and shape assembly that silently omits fields or hides defaults. Use schema-backed constructors with domain names.

Keep code simple by making the model honest. If a function needs many optional inputs, late-bound identity, defensive fallbacks, or comments explaining a temporary invalid state, move the source of truth earlier, split the variant, or make the dependency explicit.

## Effect 4

- Effect is the long-term direction for meaningful TypeScript domain, orchestration, async, resources, and expected failures. Raw Promises belong only at narrow framework or third-party adapters. Do not preserve Promise-first architecture through defensive compatibility wrappers.
- When touching legacy imperative code, shrink the Promise boundary where practical. Keep `Effect.runPromise` at runtime/framework entry points and `Effect.tryPromise` around the narrow unsafe operation that actually returns a Promise.
- Be pragmatic and readable: prefer flat named `Effect.fn` or `Effect.gen` programs with one clear `yield*` per operation. Avoid callback pyramids and long `.pipe` chains when do-notation is clearer.
- Use `Schema.decodeUnknownEffect` only at real ingress such as request bodies, response payloads, parsed JSON, database JSON, and SDK output. Keep decoded values typed; encode at wire and persistence egress. Do not re-decode trusted values or cast encoded values.
- Model expected failures with `Schema.TaggedError` for the pinned rc.116 API. Do not use JavaScript `try/catch`, `Effect.orDie`, or `Effect.orDieWith` in application/domain code.
- Use `Context.Service` for a real authority seam and provide implementations with Layers. Keep pure values and per-request inputs out of Effect context. Prefer flat Layer composition over nested provisioning pyramids.
- Read configuration with Effect `Config`. Wrap secrets in `Redacted`; never print secrets, credentials, tokens, database URLs, or supplied invalid values.
- Read `.agents/skills/effect/SKILL.md` and every matching reference branch before changing Effect code. Read `.agents/skills/effect-service-design/SKILL.md` before adding or reshaping a service. Installed package source wins when examples differ from rc.116.

## Boundaries and persistence

Shared wire contracts live in `packages/contracts`; typed client methods live in `packages/client-runtime`. Design transport-neutral APIs for web, mobile, and future desktop clients. Do not put browser-only assumptions into contracts or make app components issue ad hoc untyped requests.

A TypeScript annotation does not make a network boundary safe. `response.json()` and generic `request<T>()` casts are unknown input, not proof. Validate route params, search, headers, and bodies at every server boundary; validate response payloads at the consumer with the same Effect schema from `packages/contracts`.

Flue owns conversation/turn transport, durable conversation history, model interaction, and its runtime lifecycle. Vivid app code owns product metadata such as Thread titles and indexes, Company/Membership scope, Routines, navigation, and product records. Do not mirror library-owned state into app tables or app-owned metadata into Flue state. Read `packages/agent-runtime/AGENTS.md` before changing that boundary.

Edit the Drizzle TypeScript schema first, run the owning package's `db:generate`, and review generated SQL before migration. Never hand-write schema SQL, use `push` for a shared or remote database, or edit a snapshot manually. The migration order is `@vivid/server`, `@vivid/agent-runtime`, then `@vivid/connectors`; root `pnpm db:migrate` preserves it. Read both Drizzle skills before reading or changing schemas, queries, config, or migrations.

Alchemy `2.0.0-beta.79` peers on the pinned Drizzle RC. Workspace overrides hold Effect `4.0.0-rc.116` and Drizzle `1.0.0-rc.5-ab785fc` in lockstep. Do not relax them without validating Alchemy, Better Auth, and every migration owner together.

## Hit every surface

A feature is incomplete when it works only on the path first tested. Check web, mobile, and the future desktop surface. Check every applicable entry point: its Thread, Today, Settings, and notifications. Put shared client behavior in `packages/client-runtime` and shared wire contracts in `packages/contracts`; do not reimplement them per surface.

## Web and mobile UI

Avoid React `useEffect` in both Vite React and Expo. Prefer loaders, query primitives, event handlers, subscriptions, external-store APIs, or derived render state. `useLayoutEffect` is not an escape hatch; use it only when a frame would otherwise visibly render the wrong layout or stale content. Never put work keyed to high-frequency streamed values on the pre-paint path.

The web design system is enforced by lint. Read the diagnostic and use the variant or token it suggests. Add a component variant only when the design calls for a reusable treatment. `@shadcn/lint` owns component contracts and token usage; `oxlint-tailwindcss` owns Tailwind correctness and canonical class syntax. Draft contracts live together in `.oxlintrc.json`, with rationale and ratchets in `docs/designlint.md`; the UI owner must review changes to them.

Every click-, tap-, or keyboard-activated affordance must read as interactive: buttons, links, React Native `Pressable`/touch targets, clickable rows, menu items, labels, summaries, and icon controls. Enabled web targets need `cursor-pointer` plus visible hover or focus feedback; enabled native targets need visible pressed/focus feedback and an adequate hit area. Disabled targets use `cursor-not-allowed` or `cursor-default` on web and a visibly disabled native state, never pointer styling. Static text, badges, and containers must not look clickable. Valid web exceptions are `cursor-grab`/`cursor-grabbing` for drag handles and `cursor-default` for dismiss-only backdrops. Tailwind v4 does not supply a button pointer cursor; shared primitives must encode the invariant rather than relying on browser defaults.

## Files, comments, and tests

Filenames are one word; directories carry context. Allowed descriptive suffixes are `.test.ts`, `.test.tsx`, `.live.test.ts`, `.server.ts`, and `.tsx`. Do not add vague `utils.ts`, `helpers.ts`, or `common.ts` modules.

Comment exhaustively above logic. Every non-trivial function, class method, hook, route handler, store operation, Effect program, and implementation block with a non-obvious step needs JSDoc or a leading comment. Explain **why** the code exists: the invariant, ordering, units, data shape, failure mode, prior behavior, intended behavior, and relevant installed source or documentation. Do not restate syntax. A comment must never explain away a dishonest model; replace “this field is only set when…” with a tagged variant or `Option`.

Test observable behavior through public seams. Delete tautological tests that only repeat a literal, prove an Effect primitive, or show that a schema accepts the value used to define it. Prefer real adapters, deliberate test Layers, checked-in integration tests, and local PostgreSQL when persistence semantics matter. Do not create throwaway smoke scripts or mock the seam whose behavior the test claims to prove.

Fixtures must never touch a shared app database. Use disposable PostgreSQL through `VIVID_TEST_DATABASE_URL`, never fallback to `DATABASE_URL` or an app env file, and register cleanup before the first write so failed setup/assertions retain cleanup. Process termination can skip teardown, so database isolation is mandatory.

Vitest is the runner for app and package `.test.ts`/`.test.tsx` suites. Effect programs use `@effect/vitest` (`it.effect`, `it.live`, or shared `layer(...)`) instead of manual Effect runtimes. Tooling suites under `scripts/*.test.mjs` stay on `node --test`.

LLM-behavior live evaluations need real credentials, an explicit opt-in environment flag, and one `.live.test.ts` file per behavioral claim. They stay skipped by default and test observable structured behavior, not prompt wording.

## Verifying

Use the smallest proof that demonstrates the changed behavior: focused tests first, then the narrow lint or typecheck surface. Never use sleeps or polling in tests; wait on a typed signal, an observable receipt, or a controllable clock. A test that needs a timeout to pass is wrong. The primary agent performs one integrated pass in a real client for user-visible work; subagents never launch dev servers.

## SDKs, servers, and tools

Flue, Alchemy beta, Effect rc, Better Auth, Expo, and related SDKs move quickly. Never assume their APIs from memory. Read installed package source and version-matched docs first; for Flue use `pnpm exec flue docs ...`. Do not hack, reassign, or monkey-patch framework/SDK internals; use public APIs or an owned boundary and document a narrow removable workaround only when source proves a gap.

Only invoke a skill after reading relevant files and confirming the task surface. State which skill applies and why. When listing skills, name only verified matches; never dump the installed list.

Reuse a server already running for the same worktree. Start an independent server only on a free port, record that you started it, and stop only that process after checking its cwd. Never stop another worktree's process.

## Gates and commits

Full typecheck is a finishing move. Run it once at the end through `.husky/pre-push`, which checks package-manager policy, version lockstep, Effect boundaries, migration integrity, type-aware lint ratchets, formatting, serialized typecheck, and tooling tests. Never run two TypeScript graphs at once or typecheck in parallel with a build; use one focused leaf check only when diagnosing.

Typecheck scripts resolve `tsc` from the pinned native TypeScript preview. Keep `.cache/typescript` build info enabled and keep `@effect/language-service` patched by `prepare`; its errors, warnings, and suggestions fail typecheck. The Effect-boundary audit uses exact file+symbol classifications; add no wildcard, duplicate, or stale allowlist entry.

`HUSKY=0` is for a hook that is broken or irrelevant to the change, never for a failing gate. A red lint, format, typecheck, migration, or test result is the hook doing its job; fix every real failure. Lower warning baselines whenever findings disappear and never increase one merely to land a change.

“Merged” means GitHub `origin/main` contains the commit. A local merge, worktree, pushed feature branch, or open pull request is not merged. Report state precisely and verify the remote commit before using that word. Never push, merge, rewrite shared history, remove another worktree, or prune it without explicit instruction.

## Infrastructure and collaboration boundary

Infrastructure is local-first and nothing is deployed yet. Alchemy is the only source of truth for intended AWS resources and deploy targets; they belong in `alchemy.run.ts`, not hand-written provider files. The infrastructure lane owns that file unless a task explicitly assigns it here.

Local PostgreSQL is `postgres://vivid:vivid@127.0.0.1:55433/vivid` provisioned by the Alchemy local stack (`pnpm infra:dev`, Docker `postgres:18-alpine`); there is no compose file. Worktrees live under `~/agency/vivid-lanes/<name>`, never `/tmp`.

This repository may contain web and mobile apps, the application server, authentication, People and Companies, Projects, Threads, Messages, Library data, ordinary HTTP APIs, persistence, tests, shared contracts, and the narrow Flue conversation transport. Do not add the production scheduler, connector/tool-call implementations, computer-control transport, credential handling, proprietary execution internals, or research sources. The application server may submit work through an explicit boundary and consume status/results; it must not absorb those systems. Never un-ignore `refs/`, `docs/prds/`, or another path excluded by root `.gitignore`.

## Product language

Product copy says **Vivid**, never “agent” or “automation.” Those are implementation terms only.

- **Person**: a human who uses Vivid.
- **Company**: the top-level ownership boundary; a **Membership** carries a Person's role and permissions.
- **Project**: a recursive work container inside a Company.
- **Thread**: the durable conversation and collaboration boundary where work, questions, approvals, artifacts, and results return.
- **Message**: an immutable contribution to a Thread by a Person or Vivid.
- **Run**: one bounded attempt by Vivid to advance a Thread.
- **Input request**: a durable question that a Run cannot safely answer alone.
- **Approval**: authorization for one consequential action, preserving action, risk, rationale, scope, and decision.
- **Routine**: a reusable commitment for Vivid to act on a trigger; an **Occurrence** is one invocation and may start a Run.
- **Library item**: reusable knowledge or a learned procedure. A procedure may become a Routine, but storing it does not schedule it.
- **Artifact**: a durable, versioned input or output linked to its Thread and Run.
- **Connection**: an authorized relationship with an external account or service; credential values never enter model context.

Use these terms in code, contracts, tests, and copy. Do not create synonyms for established concepts.

## Agent skills

### Issue tracker

Issues live in this repository's GitHub Issues (`Konan69/vivid`). Use the repository's configured `origin` and report branch, pull-request, and merged state precisely.

### Domain docs

The tracked product references are under `docs/`; `docs/01-principle.md`, `docs/03-surface.md`, and the numbered feature/design documents define current language and behavior. This checkout has no tracked `CONTEXT.md` or ADR directory; create either only through an explicit domain-modeling task.

### Coding standards

`CODING_STANDARDS.md` is the review index. The vendored `coding-standards`, `effect`, `effect-service-design`, `react-useeffect`, `better-auth-best-practices`, `drizzle`, `drizzle-migrations`, `tdd`, `diagnose`, and `turborepo` skills provide task-specific detail. Root instructions win on conflict; package-level instructions such as `packages/agent-runtime/AGENTS.md` narrow their owned surface.

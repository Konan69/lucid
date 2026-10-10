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
2. **Writing to live data.** The developer's real local database and volumes are read/copy only: the `vivid` PostgreSQL instance on port 55433, Alchemy `.alchemy` state, and `packages/agent/runtime/.state`. Never point tests, migrations, cleanup, or fixtures at them. Tests use an isolated disposable database supplied only through `VIVID_TEST_DATABASE_URL`.
3. **Baking in origins.** Development is single-origin through the Vite proxy. Never bake a `localhost` URL, service origin, or runtime token into a client bundle; doing so breaks remote access and exposes runtime authority.

## Engineering standard

No overengineering means no speculative abstraction, indirection, or plumbing you do not yet need — it does **not** mean skimping on rigor. Always model the domain first: strong types, Effect `Schema` contracts, branded identifiers, and tagged variants are the baseline, never the “complex” option. “Simplest” means the simplest design that keeps the model honest, not the fewest keystrokes. Do not cite simplicity to avoid a schema, precise failure, or exhaustive state model.

Most of this repository is greenfield. When a model, contract, table, module or name is wrong for the task, change it at its source and update every caller; do not work around it, wrap it, or keep a compatibility path for a shape nothing outside this repository depends on. The exceptions are the ones that hold data or binaries we cannot rewrite: a deployed database changes only through a generated migration, and a change to the phone app's native side needs a new app version and a new binary.

Product feel matters. Keep Vivid fast, snappy, and local-first. Prefer caching, preloading, optimistic updates, and reuse of warm UI/runtime state so people rarely see avoidable loading states.

Minimal correct code wins. Solve the actual problem with the fewest concepts, indirections, and lines that preserve an honest model. Consolidate before adding. Delete wrappers that only rename a standard combinator or preserve obsolete architecture. Concise is not terse: precise types and explanatory comments still apply.

Complexity is linted: classic cyclomatic complexity 12, 120 lines per function, nesting depth 3, four parameters, three nested callbacks. A finding means the function owns more than one decision; split the variant or extract the pure step rather than flattening syntax to pass. Existing findings are ratcheted in `scripts/gate/ratchets.mjs` and may only go down.

Keep one responsibility per module. Split files that own unrelated concerns. Pure domain logic must be testable without booting a server, database, Flue runtime, Expo runtime, or browser.

Keep one source of truth for each vocabulary, invariant, and mapping. Derive dependent values so extending the source makes missing cases fail at typecheck. Where direct derivation is blocked, keep one declaration authoritative and assert total coverage of the other at the type level; never cast to force agreement.

## Taste

Keep complexity at the adapter boundary, orchestration pure, and UI dumb. Prefer inferred types over annotations when inference preserves the full domain contract. Do not add continuously repainting animations; they waste power and drop frames on high-refresh displays. If a rule fights the task, say so loudly and get human sign-off before breaking it.

## Domain honesty

Production code starts with the domain model, not plumbing. Decode unknown data once at its ingress, then keep it typed. Do not use `any`, pass-through `unknown`, non-null assertions, `?? null`, `?? ""`, `?? new Date()`, broad recovery, or optional-chaining walks to make a dishonest model compile.

Errors are part of the domain model. Failures that demand different handling need different tags with branded domain context. Never use one catch-all error discriminated by a free-form message or code string.

For closed Effect 4 states, prefer `Schema.TaggedUnion` and its generated `.cases`, `.guards`, `.isAnyOf`, and exhaustive `.match` helpers. Construct variants with the case schema's `.make`; do not recreate the state machine with raw discriminator comparisons, object literals, nested booleans, or duplicated readiness predicates. These names are verified against the pinned Effect `4.0.2` source; re-check installed source when the pin changes.

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
- Never use the throwing Schema forms in product code: `Schema.decodeSync`, `decodeUnknownSync`, `encodeSync`, `encodeUnknownSync`. They turn a value that does not fit into a defect nobody typed. In Effect code use the `...Effect` form and give the failure a tagged error (a store uses `decodeStored` and `encodeStored` in `apps/server/src/database/client.ts`, which answer `DatabaseFailure`); in plain synchronous code use the `...Result` or `...Option` form and branch on it. A constant that must exist for the process to start says so with `Result.getOrThrow` over the `...Result` form and a comment that names the reason. Tests (`*.test.ts`, `*.test.tsx`, `tests/`) are exempt: a test may throw on a fixture it wrote. The Effect language-service rule `schemaSync` in `tsconfig.base.json` enforces this at `error`, and typecheck fails on it.
- Model expected failures with `Schema.TaggedError` for the pinned Effect 4.0.2 API. Do not use JavaScript `try/catch`, `Effect.orDie`, or `Effect.orDieWith` in application/domain code.
- Use `Context.Service` for a real authority seam and provide implementations with Layers. Keep pure values and per-request inputs out of Effect context. Prefer flat Layer composition over nested provisioning pyramids.
- Read configuration with Effect `Config`. Wrap secrets in `Redacted`; never print secrets, credentials, tokens, database URLs, or supplied invalid values.
- Read `.agents/skills/effect/SKILL.md` and every matching reference branch before changing Effect code. Read `.agents/skills/effect-service-design/SKILL.md` before adding or reshaping a service. Installed package source wins when examples differ from the pinned 4.0.2.

## Boundaries and persistence

Shared wire contracts live in `packages/contracts`; the clients derived from them live in `packages/client/rpc`. Design transport-neutral APIs for web, mobile, and future desktop clients. Do not put browser-only assumptions into contracts or make app components issue ad hoc untyped requests.

A TypeScript annotation does not make a network boundary safe. `response.json()` and generic `request<T>()` casts are unknown input, not proof. Validate route params, search, headers, and bodies at every server boundary; validate response payloads at the consumer with the same Effect schema from `packages/contracts`.

Flue owns conversation/turn transport, durable conversation history, model interaction, and its runtime lifecycle. Vivid app code owns product metadata such as Thread titles and indexes, Company/Membership scope, Routines, navigation, and product records. Do not mirror library-owned state into app tables or app-owned metadata into Flue state. Read `packages/agent/runtime/AGENTS.md` before changing that boundary.

Edit the Drizzle TypeScript schema first, run the owning package's `db:generate`, and review generated SQL before migration. Never hand-write schema SQL, use `push` for a shared or remote database, or edit a snapshot manually. The migration order is the server's auth tables, then the server's product tables (`apps/server/product-drizzle.config.ts`); root `pnpm db:migrate` preserves it. Read both Drizzle skills before reading or changing schemas, queries, config, or migrations.

Alchemy `2.0.0-beta.81` peers on the pinned Drizzle RC. Workspace overrides hold Effect `4.0.2` and Drizzle `1.0.0-rc.5-ab785fc` in lockstep. Do not relax them without validating Alchemy, Better Auth, and every migration owner together.

## Hit every surface

A feature is incomplete when it works only on the path first tested. Check web, mobile, and the future desktop surface. Check every applicable entry point: its Thread, Today, Settings, and notifications. Put shared client behavior in `packages/client/rpc` and shared wire contracts in `packages/contracts`; do not reimplement them per surface.

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

## Where heavy work runs

The developer's PC is shared by every session at once, and it runs out of processor and memory. On 5 October 2026 its load average stood at twice its core count: a production deploy sat for an hour, gates failed on timeouts in code nobody had touched, and a build waited on all of it. So before starting heavy work, measure: `uptime` against `nproc`, `free -g` for memory in swap, and how many `node`, `tsc` and `vitest` processes are already running. Heavy work is a build, a bundle export, a full gate, a whole test suite, a browser run, or anything else that holds a core for minutes.

When the load average is above the core count, or memory is in swap, do the work on the Cloudbox and not on the PC. The Cloudbox is the developer's own Boat machine for builds and gates, SSH host `cloudbox-konan` (the older name `vivid-boat` resolves to it as well). The gate goes there by itself: `pnpm gate --host cloudbox-konan` keeps one warm tree per branch on it, with dependencies, build info and a Turbo cache shared by every tree, and needs no upload script. Check the Cloudbox the same way first; it is a small machine, so it takes one heavy job at a time. Never add the work to a contended PC and then report the timeout as the result. When the Cloudbox is down, the gate runs on the PC (`--here`), which starts its own disposable database.

**A Person's Computer is never a build machine.** `cloudbox-vivid` is the production Vivid Computer of a Person's account, and it is a different Boat machine from the Cloudbox. Nothing but Vivid's own product runs on it: no gate, no suite, no build, no proof stack, no emulator, no warm tree, no cache, and no SSH session to do work (an SSH wakes it, and not the way Vivid starts it). From 3 to 7 October 2026 the name `vivid-boat` pointed at it and every gate ran there. The gate's trees and caches filled its disk until Boat refused to start it ("needs 125.4 GiB of disk but the largest machine holds 125.0 GiB"), and production had no Computer for a day and a half; before that, gates woke the machine behind Vivid's back and Vivid's idle stop archived it under running gates. `scripts/gate/cloud.mjs` refuses a host that resolves to it, by what `ssh -G` reports and whatever the alias. Reading its state through the provider's API is allowed. On any Boat machine, keep dependency trees and caches out of snapshots with a `.boxignore`: Boat captures every file each minute and counts a hard link as a full copy.

Simulators, emulators and testing run on the Cloudbox, not on the developer's PC, contended or not. That covers the Android emulator, driving a browser or the app to test it, a live proof, a gate and a suite. A focused test of the file being changed is small and may run on the PC. An iOS simulator needs macOS, which neither machine has: the iPhone app is checked on the phone itself or on a macOS runner, and its JavaScript, which is all that most fixes change, is built on the Cloudbox.

## Shipping a phone change

A change to the phone app reaches the developer's iPhone one of two ways, and which one is decided by whether the native side changed.

- **JavaScript only** (screens, state, copy, assets; `pnpm-lock.yaml`, `patches/`, the `app.json` plugins and `version` all unchanged): it goes over the air. Merge it: Railway builds the server from that push to `main` and the new server publishes the update, and the installed app takes it on its second open. Do not build or hand over an IPA for it.
- **Native** (a native module added or changed, a config plugin, a patch to a native package, an Expo SDK move): raise `version` in `apps/mobile/app.json`, build the IPA from `main`, and put it in the developer's Downloads folder named with its version, `Vivid-<version>.ipa` (`Vivid-0.3.0.ipa`). Delete the IPA it replaces, there and among the CI artifacts, so there is one build to install and its name says which.

Say in the report which of the two the change was. `apps/mobile/README.md` ("Over-the-air updates") has the mechanism.

## SDKs, servers, and tools

Flue, Alchemy beta, Effect, Better Auth, Expo, and related SDKs move quickly. Never assume their APIs from memory. Read installed package source and version-matched docs first; for Flue use `pnpm exec flue docs ...`. Do not hack, reassign, or monkey-patch framework/SDK internals; use public APIs or an owned boundary and document a narrow removable workaround only when source proves a gap.

Only invoke a skill after reading relevant files and confirming the task surface. State which skill applies and why. When listing skills, name only verified matches; never dump the installed list.

Reuse a server already running for the same worktree. Start an independent server only on a free port, record that you started it, and stop only that process after checking its cwd. Never stop another worktree's process.

## Gates and commits

The gate is one command, `pnpm gate` (`scripts/gate.mjs`). Its stages are defined once in `scripts/gate/stages.mjs`: policy (package manager, version lockstep, Effect boundaries, migrations, structure), lint with its ratchets, format, typecheck, tooling tests, and tests. The push hook, the Cloudbox run and each GitHub job call it; never list a check anywhere else. It prints each stage's time and cache hits and ends with one verdict line that names the commit and the run.

- `pnpm gate` is the full gate, and the only verdict that allows a merge. Every stage is a Turbo task hashed per package, tests included, so a package whose files and dependencies did not change is replayed, not run again. Run it as often as you like: with nothing changed it takes seconds.
- `pnpm gate affected` runs every stage but only the test files whose imports reach what the branch changed. It is the working loop, not a merge gate: a test that reads a file without importing it is outside that graph.
- `pnpm gate focused <test files...>` runs only the named test files, with the test database. Use it while fixing one suite.
- `--only lint,typecheck` selects stages. `--host <ssh host>` (or `VIVID_GATE_HOST`) runs in a warm tree on that machine: the commit, or a snapshot of uncommitted work, is pushed there and the result is followed by its run identifier, so an old result is never read as this one. `--here` runs in this checkout.

Every run gets its own empty database on a disposable server and drops it at the end, so two gates never share state and none waits for another. Without a database server the gate fails; it never skips the database suites. Live proofs (`*.live.test.ts` and suites behind a `VIVID_LIVE_*` setting) are not part of the gate: Turbo gives a test task only the settings its definition names, so run a live proof with Vitest directly. Lint and typecheck run one Turbo task at a time, because each holds a whole TypeScript program in memory; tests run beside them. Never run two TypeScript graphs at once outside the gate or typecheck in parallel with a build; use one focused leaf check only when diagnosing.

A Turbo task for one package (`@vivid/server#lint`) replaces the generic task; Turbo does not merge them. Repeat the generic task's `inputs`, `outputs` and environment in every such task; `scripts/gate.test.mjs` fails when one drifts.

Typecheck runs `tsc-rs` (pingdotgg/ts-rust, a Rust port of the native TypeScript compiler with the Effect language service rules built in) through `scripts/types.mjs`; no typecheck script calls a compiler directly. It checks the whole graph cold in 11 s against 28 s for native `tsc` 7.0.2, at the same 2 GB peak, with the same diagnostics (`docs/checks.md`, "The type checker is ts-rust"). `@typescript/native` 7.0.2 stays installed for typed lint, editors and the web build, and `prepare` patches it with `effect-tsgo`, so an editor shows the same Effect findings. Keep `.cache/typescript` build info enabled. Effect findings are printed and counted on the gate's typecheck line and do not fail it until the existing ones are fixed (branch `fix/effect-findings`); then Effect errors and warnings fail typecheck again.

`tsc-rs` 0.1.0 follows TypeScript 7.1's nightlies and so reports TS7031 for a destructured parameter element missing from a `= {}` default even where an annotation or the contextual type gives it a type. Our fix for that is open upstream (microsoft/TypeScript pull request 64671, pingdotgg/ts-rust pull request 17). Until a release has it, annotate such a parameter, as `packages/agent/runtime/src/tools/sandbox.ts` does, and remove the annotation with the upgrade.

The type checker will change again: the plan is to move to Bun's type checker (`bun check`) later. ts-rust's own benchmark on a comparable Effect codebase has it at about half of `tsc-rs`'s time without the Effect rules, but it has no Effect diagnostics of its own yet, and with a separate Effect pass it is slower than `tsc-rs`. Switch when it reports the Effect findings itself, by changing `typeChecker` in `scripts/types.mjs` and re-running the comparison in `docs/checks.md` on this repository first: same diagnostics, time and peak memory for the whole graph. Nothing else should name a compiler.

The Effect-boundary audit uses exact file+symbol classifications; add no wildcard, duplicate, or stale allowlist entry.

`HUSKY=0` is for a hook that is broken or irrelevant to the change, never for a failing gate. A red lint, format, typecheck, migration, or test result is the hook doing its job; fix every real failure. Lower warning baselines whenever findings disappear and never increase one merely to land a change.

“Merged” means GitHub `origin/main` contains the commit. A local merge, worktree, pushed feature branch, or open pull request is not merged. Report state precisely and verify the remote commit before using that word. Never push, merge, rewrite shared history, remove another worktree, or prune it without explicit instruction.

## Infrastructure and collaboration boundary

Infrastructure is local-first, and production runs on Railway (see `docs/19-infrastructure.md`, "Deploying to production"). Alchemy is the only source of truth for the local stack and the deploy target; resources belong in `alchemy.run.ts`, not hand-written provider files. The infrastructure lane owns that file unless a task explicitly assigns it here.

Local PostgreSQL is `postgres://vivid:vivid@127.0.0.1:55433/vivid` provisioned by the Alchemy local stack (`pnpm infra:dev`, Docker `postgres:18-alpine`); there is no compose file. Worktrees live under `~/agency/vivid-lanes/<name>`, never `/tmp`.

This repository holds the whole product: the web, mobile and desktop apps, the application server and every piece of product logic, authentication, the Flue runtime, connectors, the Computer, shared contracts, tests and the design documents under `docs/`. Backend logic lives in `apps/server`, organized by domain; a package exists only for code that more than one app imports. What stays out, and stays ignored by root `.gitignore`: client requirement documents (`docs/prds/`), third-party reference checkouts (`refs/`), generated decks and dumps (`artifacts/`), `CONTEXT.md`, and every secret. Committed files never name a client, an investor or a funding conversation, and never contain an absolute path on someone's machine.

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
- **Connection**: an authorized relationship with an external account or service; credential values never enter model context. People see it as an **Integration**: that is the word in every string a Person or the model reads, while code, contracts and tests keep `Connection`.

Use these terms in code, contracts, tests, and copy. Do not create synonyms for established concepts.

**Borrowed code takes Vivid's names.** Any function, type, module, file, table, environment variable, event, or concept adapted from another project — a reference implementation, an SDK example, or one of our own earlier products — is renamed to this document's vocabulary and file conventions before it lands. The source's names never survive: no `box`, `sand`, `agent`, `bot`, `pod`, or another product's prefixes in identifiers, paths, logs, comments, or copy. Name the thing for what it is in Vivid (`Computer`, `Person`, `Thread`, `Run`, `Artifact`), and record where the design came from in the JSDoc, not in the identifier.

**A reference implementation is a guide to follow, not inspiration.** When an inspected reference already solves the problem — source on disk or a decompiled binary — port it, or adapt it where Vivid differs: keep its mechanism, platform APIs, process layout, protocol methods and message shapes, ordering, limits, timeouts, and failure behavior. Do not redesign it from scratch, simplify it away, or substitute a mechanism recalled from memory. Before claiming the reference lacks something, search it; absence must be checked, not assumed. Cite the reference file and symbol or address in the JSDoc. Where Vivid's architecture, domain model, or the naming rule above requires a change, adapt and state the change and its reason beside the code. Where the reference cannot be inspected or a claim about it is unproved, say so; never fill the gap with a guess.

## Agent skills

### Issue tracker

Issues live in this repository's GitHub Issues (`Konan69/vivid`). Use the repository's configured `origin` and report branch, pull-request, and merged state precisely.

### Domain docs

The product references are under `docs/`, numbered in reading order: `docs/01-principle.md` and `docs/03-surface.md` define the product, `docs/04-computer.md` the Computer, `docs/09-platform-architecture.md` and `docs/17-backend-stack-reference.md` the platform, and the rest a feature each. This checkout has no tracked `CONTEXT.md` or ADR directory; create either only through an explicit domain-modeling task.

### Coding standards

`CODING_STANDARDS.md` is the review index. The vendored `coding-standards`, `effect`, `effect-service-design`, `react-useeffect`, `better-auth-best-practices`, `drizzle`, `drizzle-migrations`, `tdd`, `diagnose`, and `turborepo` skills provide task-specific detail. Root instructions win on conflict; package-level instructions such as `packages/agent/runtime/AGENTS.md` narrow their owned surface.

## Design stack

UI work follows the design stack in `AGENTS.md` ("Design stack (UI work)"): load the named skills in order (direction, polish, motion, review), render every state, and get a criticised second pass before committing.

Inside T3 Code a session can show an HTML page in the thread: `html_preview` renders it off-screen and returns the picture, and `html_render` publishes it above the reply. Both are `t3-code` tools; when they are listed as deferred, load them with ToolSearch. Use the page in two places:

- **Mockup before building.** When a design is being decided, draw the proposed screen, or two or three variants side by side, in the project's own tokens at the surface's width, beside a capture of the screen as it is now. The developer chooses from the page and the build follows the choice. The page says that it is a mockup.
- **Board of what was checked.** After the pass on a device or in a browser, publish the captures as one page, each with a line saying what it shows and where it was taken.

A mockup settles direction; the built screen still gets its pass on a device.

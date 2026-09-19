# Vivid agent instructions

## Session rules

- Be concise. Take the next safe, non-destructive step without waiting for permission, and keep moving until the task is complete or a real blocker appears.
- Read the nearest `AGENTS.md`, the relevant code, and the matching skill before changing an unfamiliar surface. Inspect the project-pinned package source when an API detail matters.
- Keep changes narrow and production-ready. Model the domain rigorously; do not confuse fewer keystrokes with simpler design.
- Never use `git stash`. Several contributors may share a branch, and a stash hides work. Make focused commits that contain only the files for one concern.
- Prefer `rg` for search. Preserve method receivers: call `object.method(...)`; never destructure a method and call it loose unless it is explicitly bound.

## Domain honesty

Model the domain before the plumbing. Effect `Schema` contracts, branded identifiers, and tagged variants are the baseline for meaningful TypeScript. Parse unknown data once at its ingress, then keep it typed.

Do not use `any`, pass-through `unknown`, non-null assertions, `?? null`, `?? ""`, or optional-chaining walks to make a dishonest model compile. If code branches on which optional fields happen to exist, replace the bag with a required field, `Option`, or a tagged variant. Expected failures are part of the model and remain visible in the error channel.

Keep one source of truth for each vocabulary, invariant, and mapping. Derive dependent values so extending the source makes missing cases fail at typecheck rather than at runtime.

## Effect 4

- Use Effect for domain orchestration, asynchronous work, resources, and expected failures. Raw Promises belong only at narrow framework or third-party adapters.
- Use `Effect.gen` or a named `Effect.fn` with one clear `yield*` per operation. Prefer flat layer composition over nested provisioning pyramids.
- Model expected failures with `Schema.TaggedError` for the pinned Effect 4 rc.112 API. Do not use JavaScript `try/catch`, `Effect.orDie`, or `Effect.orDieWith` in application/domain code.
- Use `Context.Service` for a real authority seam and provide implementations with Layers. Keep pure values and per-request inputs out of Effect context. Read `.agents/skills/effect-service-design/SKILL.md` before adding or reshaping a service.
- Decode request bodies, parsed JSON, database JSON, and SDK payloads with Effect `Schema` at the boundary. Do not re-decode already typed values or cast encoded values.
- Read configuration with Effect `Config`. Wrap secrets with `Redacted`; never print secrets, credentials, tokens, or database URLs.
- Preserve receiver semantics for services, SDKs, browser objects, and runtime stubs: `object.method()` only.
- Read `.agents/skills/effect/SKILL.md` and every matching reference branch before changing Effect code. The installed package source wins when vendored examples differ from rc.112.

## Drizzle and persistence

Edit the TypeScript schema first, then run the owning package's `db:generate`. Review generated SQL before migration. Never hand-write schema SQL, never use `push` for a shared or remote database, and never edit a snapshot by hand.

The migration order is `@vivid/server`, `@vivid/agent-runtime`, then `@vivid/connectors`; root `pnpm db:migrate` preserves that order. Load `.agents/skills/drizzle/SKILL.md` and `.agents/skills/drizzle-migrations/SKILL.md` before reading or changing a Drizzle schema, config, query, or migration.

## Gates and commits

- Full typecheck is a finishing move. Run it once at the end through `.husky/pre-push`, which runs lint with warning ratchets, format check, and `turbo run typecheck --concurrency=1`.
- Never run two TypeScript graphs at once or run typecheck in parallel with a build. A focused leaf check is acceptable while diagnosing one package.
- Never use `HUSKY=0` to bypass a failing gate. Fix every real lint, format, typecheck, or test failure.
- Lower a pre-push warning baseline whenever warnings are removed. Never increase a baseline to land a change.
- Commit after each major concern with a focused message. Stage by explicit path so unrelated work stays visible.

## Files, comments, and tests

Filenames are one word; directories carry context. Allowed descriptive suffixes are `.test.ts`, `.test.tsx`, `.server.ts`, and `.tsx`. Do not add vague `utils.ts`, `helpers.ts`, or `common.ts` modules.

Add JSDoc or a leading comment above every non-trivial function, class method, hook, route handler, store operation, and Effect program. Explain the invariant, ordering, units, failure mode, or design reason—not the syntax. A comment must not excuse a dishonest type.

Test observable behavior through public seams. Do not add tautological tests, module mocks, or tests that merely prove an Effect primitive or schema accepts the literal used to define it. Prefer real adapters, deliberate test Layers, and local PostgreSQL when persistence semantics matter.

## Infrastructure and worktrees

Alchemy is the only source of truth for remote deployment. Remote resources and deploy targets belong in `alchemy.run.ts`; do not add hand-written remote provider configuration. The infrastructure lane owns that file unless a task explicitly assigns it here.

Worktrees live under `~/agency/vivid-lanes/<name>`, never under `/tmp`. Do not remove or prune another worktree, stop a process you did not start, push without instruction, or rewrite shared history.

## Collaboration boundary

This repository may contain the web and mobile apps, the application server, authentication, people and Companies, Projects, Threads, Messages, Library data, ordinary HTTP APIs, persistence, tests, shared contracts, and the narrow Flue conversation transport.

Do not add the production scheduler, connector or tool-call implementations, computer-control transport, credential handling, proprietary execution internals, or research sources. The application server may submit work through an explicit boundary and consume status or results; it must not absorb those systems. Never un-ignore `refs/`, `docs/prds/`, `packages/client-runtime/`, or other paths excluded by the root `.gitignore`.

## Product language

Product copy says **Vivid**, never “agent” or “automation.” Those are implementation terms only.

- **Person**: a human who uses Vivid.
- **Company**: the top-level ownership boundary; a **Membership** carries a Person's role and permissions.
- **Project**: a recursive work container inside a Company.
- **Thread**: the durable conversation and collaboration boundary where work, questions, approvals, artifacts, and results return.
- **Message**: an immutable contribution to a Thread by a Person or Vivid.
- **Run**: one bounded attempt by Vivid to advance a Thread.
- **Input request**: a durable question that a Run cannot safely answer alone.
- **Approval**: authorization for one specific consequential action, preserving its action, risk, rationale, scope, and decision.
- **Routine**: a reusable commitment for Vivid to act on a trigger; an **Occurrence** is one invocation of that Routine and may start a Run.
- **Library item**: reusable knowledge or a learned procedure. A procedure may become a Routine, but storing it does not schedule it.
- **Artifact**: a durable, versioned input or output linked to its Thread and Run.
- **Connection**: an authorized relationship with an external account or service; credential values never enter model context.

Use these terms in code, contracts, tests, and copy. Do not create synonyms for established concepts.

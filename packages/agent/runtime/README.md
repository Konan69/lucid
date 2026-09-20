# Vivid agent runtime

Shareable Flue Node runtime for the initial Vivid conversation experience and demo routines.
Production scheduler orchestration, connectors, tool execution, and computer-control code are
intentionally not part of this package.

## Run

Requires Node 22.19 or newer and a provider API key matching `VIVID_MODEL`.
Local secrets belong in the ignored `.env` file.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Defaults:

- model: `openrouter/z-ai/glm-5.3-flash`
- development port: `5173`
- PostgreSQL: `DATABASE_URL` (local example uses `127.0.0.1:55433/vivid`)

Flue's durable conversation stream and Vivid's application tables are stored in PostgreSQL. Flue
runs its idempotent `migrate()` at startup; the runtime's versioned application migration creates
the `vivid_*` tables. No `.state/` volume is needed. The Library has real nested folders and accepts
multi-file PDF, Markdown, and plain-text uploads up to 10 MB each. Text is extracted, chunked, and
indexed with PostgreSQL `tsvector` plus a GIN index. The read-only `search_library` Flue tool returns
citation-ready passages with the same filename/page citation shape. Retrieval uses PostgreSQL
`websearch_to_tsquery('simple', ...)` and `ts_rank_cd`; it is keyword-based and has no embeddings,
OCR, or vector store.

Routines use the same database for definitions and run history. On Node, `croner` provides the
in-process trigger and each fire enters Flue as a durable `schedule` signal. Authenticated
`/api/routines` routes provide create, edit, pause, delete, and test-run operations. This is a
single-process demo adapter: production should use a platform scheduler so deploy downtime does not
drop fires and multiple replicas do not duplicate them.

Tasks, follow-ups, and notifications live in the same PostgreSQL database. The agent mounts
`create_task`, `update_task`, `list_tasks`, and `schedule_follow_up`. A 20-second in-process ticker
fires due follow-ups as durable `follow-up` signals into the task's own conversation (`task-<id>`)
and records overdue work once, chasing it automatically when nothing is already scheduled.
Authenticated `/api/tasks`, `/api/follow-ups`, and `/api/notifications` routes back the Today
screen. Same demo caveat as routines: production needs a platform scheduler.

Routine and follow-up runs persist the Flue submission id and reattach with `read(submissionId)`
after a restart. Dispatch uses each occurrence id as its stable idempotency key, so a crash between
admission and saving the receipt cannot create a duplicate turn. Mutating task tools are Flue durable
tools and use deterministic operation ids, making replayed PostgreSQL writes idempotent. Completion
updates use a running-state predicate and the follow-up result plus notification commit in one
transaction, so duplicate recovery cannot publish twice.

`DATABASE_URL` is required at runtime. Override the model with `VIVID_MODEL`. The old
`VIVID_RUNTIME_DB` and `VIVID_CONNECTOR_DB` variables are no longer used.

## Deployment

Build and run one Node 22 process:

```sh
pnpm install --frozen-lockfile
pnpm --filter @vivid/agent-runtime build
DATABASE_URL=postgres://... VIVID_RUNTIME_TOKEN=... OPENROUTER_API_KEY=... pnpm --filter @vivid/agent-runtime start
```

The included `Dockerfile` uses Node 22 and exposes port `5173`; set `DATABASE_URL`,
`OPENROUTER_API_KEY`, `VIVID_RUNTIME_TOKEN`, and (when needed) the Google OAuth variables at
runtime. The container healthcheck calls unauthenticated `/health`. Run a single replica unless a
platform scheduler replaces the in-process routine/follow-up tickers. PostgreSQL is the durable
state that must be backed up; the container filesystem is disposable.

**Credential warning:** Google OAuth access and refresh tokens are currently stored in plaintext in
`vivid_credentials`. Encrypting them requires a deliberate key-management decision. See the TODO at
the storage code site; this cutover does not encrypt them.

## Flue documentation

The installed CLI includes all 95 version-matched documentation pages:

```sh
pnpm docs
pnpm exec flue docs search skills
pnpm exec flue docs read guide/skills
```

The current upstream Flue repository and official example skills may be kept locally under the
root repo's ignored `refs/` directory. They are research inputs, not collaboration deliverables.

## Probe

```sh
curl http://127.0.0.1:5173/health

curl -X POST http://127.0.0.1:5173/agents/vivid/demo-thread \
  -H 'Authorization: Bearer local-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Say hello in one sentence."}'
```

The Flue agent instance ID maps directly to the product thread ID. The included cron adapter proves
scheduled dispatch locally; production orchestration, connectors, approvals, tools, and computer
execution remain outside this cutover.

Flue 2.0.3 predates GLM 5.3 in its bundled model catalog, so the runtime adds that
single OpenRouter model locally while retaining Flue's built-in OpenRouter transport and auth.

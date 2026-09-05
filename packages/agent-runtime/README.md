# Vivid agent runtime

Shareable Flue Node runtime for the initial Vivid conversation experience and demo routines.
Production scheduler orchestration, connectors, tool execution, and computer-control code are
intentionally not part of this package.

## Run

Requires Node 22.19 or newer and a provider API key matching `KONAN_MODEL`.
Local secrets belong in the ignored `.env` file.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Defaults:

- model: `openrouter/z-ai/glm-5.3-flash`
- development port: `5173`
- SQLite: `.state/flue.sqlite`

The same SQLite file stores Flue's durable conversation stream, Vivid's lightweight conversation
index, and the local document Library. The Library has real nested folders and accepts multi-file
PDF, Markdown, and plain-text uploads up to 10 MB each. Text is extracted, chunked, and indexed with
SQLite FTS5. The read-only `search_library` Flue tool returns citation-ready passages to the model.
This demo retrieval path is keyword-based; it does not include embeddings, OCR, or a vector store.

Routines use the same database for definitions and run history. On Node, `croner` provides the
in-process trigger and each fire enters Flue as a durable `schedule` signal. Authenticated
`/api/routines` routes provide create, edit, pause, delete, and test-run operations. This is a
single-process demo adapter: production should use a platform scheduler so deploy downtime does not
drop fires and multiple replicas do not duplicate them.

Tasks, follow-ups, and notifications live in the same database. The agent mounts `create_task`,
`update_task`, `list_tasks`, and `schedule_follow_up`. A 20-second in-process ticker fires due
follow-ups as durable `follow-up` signals into the task's own conversation (`task-<id>`) and records
overdue work once, chasing it automatically when nothing is already scheduled. Authenticated
`/api/tasks`, `/api/follow-ups`, and `/api/notifications` routes back the Today screen. Same demo
caveat as routines: production needs a platform scheduler.

Routine and follow-up runs persist the Flue submission id and reattach with `read(submissionId)`
after a restart. Dispatch uses each occurrence id as its stable idempotency key, so a crash between
admission and saving the receipt cannot create a duplicate turn. Mutating task tools are Flue
durable tools and use deterministic operation ids, making replayed SQLite writes idempotent.

Override the model with `KONAN_MODEL` and the database file with `KONAN_RUNTIME_DB`.

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

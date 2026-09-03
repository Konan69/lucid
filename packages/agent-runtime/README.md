# Konan agent runtime

Shareable Flue Node runtime for the initial Konan conversation experience. Proprietary scheduling,
connectors, tool execution, and computer-control code are intentionally not part of this package.

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

The same SQLite file stores both Flue's durable conversation stream and Konan's lightweight
conversation index (title, preview, and update time). The index is exposed through authenticated
`GET /api/conversations` and `PUT /api/conversations/:id` routes.

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

curl -X POST http://127.0.0.1:5173/agents/konan/demo-thread \
  -H 'Authorization: Bearer local-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Say hello in one sentence."}'
```

The Flue agent instance ID maps directly to the product thread ID. Scheduling, connectors,
approvals, tools, and computer execution are intentionally outside this first cutover.

Flue 2.0.3 predates GLM 5.3 in its bundled model catalog, so the runtime adds that
single OpenRouter model locally while retaining Flue's built-in OpenRouter transport and auth.

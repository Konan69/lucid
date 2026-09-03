# Konan Flue runtime

This is the shareable [Flue](https://flueframework.com) conversation runtime. Keep its scope narrow:
chat transport, durable conversation history, and the model adapter.

## Layout

- `src/agents/` — `'use agent'` modules. Capitalized exports are durable agents.
- `src/app.ts` — explicit Hono route map.
- `src/db.ts` — durable Flue conversation, attachment, and submission storage.
- `src/providers/` — model-provider catalog extensions.
- `src/skills/` — imported Agent Skills mounted with `useSkill`.

## Commands

- `pnpm exec flue run src/agents/konan.ts --message "Hi"` — run without HTTP.
- `pnpm dev` — start the Vite/Flue server.
- `pnpm build && pnpm start` — build and run `dist/server.mjs`.
- `pnpm check:types` — typecheck.
- `pnpm docs` — list the complete bundled Flue documentation.
- `pnpm exec flue docs search <query>` — search version-matched docs.
- `pnpm exec flue docs read <path>` — read a complete documentation page.
- `pnpm exec flue add` — list official integration blueprints.

## Runtime contract

- Default model: `openrouter/z-ai/glm-5.3-flash`.
- Secrets are loaded from the ignored `.env`; never print or commit them.
- SQLite defaults to `.state/flue.sqlite`.
- Do not add scheduling, connectors, tools, credential flows, or execution internals here; those
  remain outside the collaboration repository.
- A Flue conversation is the durable unit. A bounded job is a harness tool, not a workflow primitive.

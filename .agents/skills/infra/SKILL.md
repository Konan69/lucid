---
name: infra
description: Operate and verify Vivid's local-first Alchemy infrastructure without touching AWS.
---

# Vivid infrastructure

Use this skill for local infrastructure work in this repository.

## Safety boundary

- The only enabled target is `local`.
- Do not use `alchemy deploy`, `Alchemy.remote()`, AWS consoles, or cloud APIs.
- `preview` and `production` are names reserved for future work; selecting either must fail with `RemoteDeploymentDisabled`.
- Do not add Neon, Railway, Cloudflare, hosted Postgres, S3, Secrets Manager, or SSM without a new approved architecture decision.
- Never print `DATABASE_URL`, tokens, OAuth secrets, or authentication secrets.

## Required local tools

- Node.js and pnpm matching the repository.
- Docker with permission to create a container, volume, and port mapping.
- Free host ports `55433`, `5173`, `5178`, and `8787`.

AWS credentials are not required and should not be configured for this workflow.

## Required credentials

Set these before startup:

- `AUTH_SECRET` (at least 32 characters)
- `OPENROUTER_API_KEY`
- `VIVID_RUNTIME_TOKEN`

Optional Google OAuth must be supplied as the complete trio `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. `VIVID_MODEL` is optional.

## Commands

1. `pnpm infra:verify` — offline static verification only.
2. `pnpm infra:dev` — start PostgreSQL, ordered migrations, runtime, server, and web under `alchemy dev`.
3. `pnpm infra:destroy` — stop and delete only this local stack's managed resources/state.

Do not run Drizzle `generate` during startup or deployment. Generation is a developer-time schema task. Startup applies committed migrations in this exact order: server, agent-runtime, connectors.

## Expected local endpoints

| Service | URL |
|---|---|
| Web | `http://127.0.0.1:5178` |
| Server | `http://127.0.0.1:8787` |
| Agent runtime | `http://127.0.0.1:5173` |
| PostgreSQL | `postgresql://vivid:…@127.0.0.1:55433/vivid` |

Keep the Flue runtime as one long-lived process. Do not add replicas or per-request startup.

## Failure handling

- Missing app credentials: set the variable named by `InfrastructureEnvironmentError`.
- Partial Google configuration: set all three Google variables or remove all three.
- Port collision: stop the conflicting local process; do not change pinned ports ad hoc.
- Migration failure: fix the failing migration; do not reorder or skip later migrations.
- Docker unavailable: start Docker, then rerun `pnpm infra:dev`.
- Remote target error: expected. Remote deployment is not implemented.

## Emulated versus real

PostgreSQL is a real local Docker container. The server and runtime are real local Node processes supervised by Alchemy. The SPA is a real Vite process through the AWS Website local provider. Floci may run as Alchemy's local AWS sidecar, but this stack does not opt any resource into live AWS.

## Enabling remote AWS later

1. Approve the remote database, service networking, callback URLs, scaling, state backend, and teardown policy.
2. Add only the selected AWS resources behind the existing typed target switch.
3. Keep `DATABASE_URL` behind `infra/database.ts` and keep production teardown disabled.
4. Mark the target runnable only after offline verification and an independent deployment review exist.
5. Add remote commands and provider credentials only in that future change; do not use `Alchemy.remote()` as a shortcut.

Architecture details and the exact beta.76 local-provider inventory are in `docs/19-infrastructure.md`.

---
name: verify-vivid
description: 'Verify Vivid product behavior through its real web client, authenticated RPC, Flue runtime and disposable PostgreSQL. Use before calling a product behavior change done, and record the touched feature file and evidence path in the PR.'
---

# Verify Vivid

Product files are read-only. Read the [feature map](features/README.md), then the touched feature. Run heavy work on the host returned by `~/bin/devbox-pick`; never use a Person's Computer or cloudbox-vivid. This skill launches an isolated composition of production server handlers and SQL stores beside the full shipped Flue runtime and web app. It does not launch the complete `apps/server/src/main.ts` graph. See [boundaries](references/boundaries.md) before relying on a verdict.

## Launch

Set `VIVID_VERIFY_DEVBOX` to the alias returned by devbox-pick (replace cloudbox-konan below when needed). From an isolated checkout on that devbox, inspect `uptime`, `nproc`, `free -g` and `docker ps`. Use `worktree-seed.sh` if the repo or `~/bin` supplies it; otherwise `pnpm install --frozen-lockfile`. Require Node 24+, the pinned pnpm, Docker with postgres:18-alpine, Python 3 with pidfd support, and flock.

```sh
VIVID_VERIFY_DEVBOX=cloudbox-konan .agents/skills/verify-vivid/verify launch
```

Launch records `.cache/verify/flue-<timestamp>-<uuid>/state.json` before acquisition. Each run reserves fresh ports, an exact labelled PostgreSQL container, a synthetic Better Auth account, runtime notes, Vite caches and process generations. It applies both shipped migration owners. It builds through the runtime's shipped `pnpm build` and starts its emitted bootstrap with `VIVID_MODEL=rehearsal/script`. This is main's context-driven Pi faux provider. The full Vivid instructions and real tool handlers run; no provider key or cut-down prompt is used.

Readiness requires PostgreSQL health, bound server/runtime/web receipts, runtime health advertising rehearsal/script, proxied health and successful signup/signin. A failed launch retains logs and attempts cleanup. Run Cleanup even after failure. A live previous run is a conflict; clean its printed id explicitly.

## Doctor

```sh
.agents/skills/verify-vivid/verify doctor
```

Require exit 0 and `worthy: true` in `doctor.json`. Doctor checks captured boot/start ticks, listener ownership, exact Docker label/port, database readiness, rehearsal health and the single-origin proxy. It only reads the product and writes evidence. It does not repair the instance.

## Drive

```sh
.agents/skills/verify-vivid/verify feature first
.agents/skills/verify-vivid/verify feature tool
.agents/skills/verify-vivid/verify feature document
.agents/skills/verify-vivid/verify browser
```

`feature all` attempts every mapped HTTP recipe. Failed or blocked verdicts make the command fail. Person mutations use Better Auth cookies and the public schema-derived NDJSON RPC; chat uses the real server gateway and public Flue SDK. WatchThread proves durable settlement independently of stream EOF. No internal setter or test-only product endpoint is driven.

`browser` runs the existing agent-browser workflow headlessly on this same devbox, with its own namespace/session/profile and installed Chrome. Set `VIVID_VERIFY_BROWSER` to an installed native CLI path if it is not on PATH. It signs in via Email, Password and Sign in; sends in Message Vivid with Send; captures first message, rich table and document journeys, then reloads and captures them. It closes its browser in finally. Browser failure is a failed verdict, never an HTTP pass.

For a collaborative T3 preview run, use preview_status, preview_open on the printed web origin, snapshot and the same accessible names. Record with preview_recording_start/stop and close only the tab you opened. The browser must execute on the devbox; do not start local browser work. For other features, follow their exact entry points rather than substituting one convenient mutation.

## Evidence

Keep `.cache/verify/flue-…/` after Cleanup. Each run retains its commit, branch, port/container manifest, build/start logs, Doctor, action request/response bodies, public stream/history, settlement, read-only SQL and per-feature verdicts. Browser evidence retains command/output, accessibility snapshots and screenshots before and after reload. Secrets and the synthetic session stay in disposable `instance/` and are removed.

A screenshot proves only its visible state. Prove the Person action and resulting state together, plus durable side effects. Rehearsal scenes prove plumbing and real tool effects; they do not evaluate unscripted model quality. A new commit needs new evidence. In the PR body name `.agents/skills/verify-vivid/features/<feature>.md` and the surviving evidence directory, with devbox hostname.

## Cleanup

```sh
.agents/skills/verify-vivid/verify cleanup
docker ps -a --filter label=vivid.verify --format '{{.Names}} {{.Status}} {{.Ports}}'
```

Cleanup validates canonical paths and exact container labels, signals only captured process generations, removes its anonymous database volume, browser profile and scratch, and preserves proof. Recovery uses boot ids/start ticks and pidfd after a supervisor crash. Never kill by name or pattern. Confirm the captured PIDs have gone with `ps -p <manifest-pids> -o pid,ppid,args`, its ports have no listeners with `ss -ltnp`, and its exact container is absent with `docker ps -a`. Save these outputs in `cleanup-audit.txt`. An ownership mismatch is a refusal, not a cleaned run.

## Helpers

The executable `verify` dispatches launch, doctor, feature, browser and cleanup. An optional printed flue-… id selects a retained run. `create-thread`, `chat 'phrase'`, `history`, `sign-in` and `stop` are manual public helpers; use only a real selected Thread.

Ownership and crash regression checks run on the devbox with `node --test .agents/skills/verify-vivid/scripts/recovery.test.mjs`. Narrow helper formatting/lint use `pnpm exec oxfmt --config .agents/skills/verify-vivid/format.mjs --check .agents/skills/verify-vivid` and `pnpm exec oxlint --config .agents/skills/verify-vivid/lint.mjs .agents/skills/verify-vivid`. The configs inherit repo rules and remove only the blanket skill exclusion.

Use `/maintain-verification-skill` when contracts, scenes or controls change. Keep the feature map and owner hash current.

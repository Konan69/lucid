---
name: verify-vivid
description: Verify Vivid behaviour through its real server entry, web client, full agent prompt, model, tools and disposable stores. Use before calling a product behaviour change verified. Record the feature file and surviving evidence path in the PR.
---

# Verify Vivid

Read the [feature map](features/README.md), the touched feature and [runtime boundaries](references/boundaries.md). Product source stays unchanged. This skill starts `apps/server/src/main.ts`, the shipped Flue runtime and web, with disposable PostgreSQL and Helix. A missing recipe or authority is blocked, never verified.

## Host and credentials

Run `~/bin/devbox-pick` and use the Cloudbox alias it prints. Never use cloudbox-vivid. If no devbox is reachable, stop and report verification blocked. Evidence records selected alias, Boat sandbox id, hostname and boot identity. Launch checks the alias against the box's `BOAT_ID` (stable across restarts) in `./scripts/settings.mjs`; refresh that mapping only when a devbox is replaced. Keep provider keys in a private file such as `~/.config/vivid/verify.env` (mode 0600) and pass it as `VIVID_VERIFY_KEY_FILE`.

On the selected host inspect `uptime`, `nproc`, `free -g` and `docker ps`. Use a separate checkout of the intended commit. Install with `pnpm install --frozen-lockfile`. Require Node 24+, pinned pnpm, Docker, Python 3 with pidfd, flock, agent-browser 0.39.0 or later and Chrome. Install a compatible agent-browser version as a devbox prerequisite before launch. Keep dependencies and caches out of Boat snapshots with `.boxignore`.

Set `VIVID_VERIFY_KEY_FILE` to an explicit private env file, or export the provider keys for this run. No development env or CLI auth store is read automatically. Only EXPLABS_API_KEY, OPENROUTER_API_KEY and OPENCODE_API_KEY are read. Never print or retain credentials in evidence. Do not copy [local Claude settings](../../../.claude/settings.local.json) or CLI auth stores into the proof checkout or evidence. For a remote checkout, copy only these keys into a mode-0600 private file on the selected host; delete it after cleanup. The real server memory/title model needs EXPLABS_API_KEY, or OPENROUTER_API_KEY, which Launch then selects with `VIVID_SERVER_MODEL_PROVIDER=openrouter`. No production infrastructure setting is imported.

`VIVID_VERIFY_MODEL` selects a shipped model id. With a key available the default is a real model, preferring the shipped default `opencode-go/glm-5.3-flash` when its key exists. Explicit `rehearsal/script` proves plumbing only. Every feature file states its model requirement. Read [boundaries](references/boundaries.md) for unavailable external authorities.

## Launch and doctor

```sh
VIVID_VERIFY_DEVBOX=cloudbox-konan VIVID_VERIFY_KEY_FILE=/private/verify.env .agents/skills/verify-vivid/verify launch
.agents/skills/verify-vivid/verify doctor flue-<printed-id>
```

Require exit 0 and `worthy: true` from doctor. Launch captures HEAD, `git status --porcelain=v1 -uall` and a SHA-256 hash of `git diff --binary HEAD`. Dirty trees are labelled dirty in state, doctor and every verdict. Untracked paths, byte lengths and file contents also feed the hash. A clean commit claim requires a clean run at that commit. A changed tree or HEAD requires a new launch. Launch removes instance/provider.json immediately after reading it. The launch finally block and both cleanup paths remove it even if later teardown fails. Launch writes `.cache/verify/current`; omitted ids select that pointer, never the newest directory. Prefer an explicit id in reports and scripts.

Each run owns fresh ports, labelled containers, synthetic Better Auth account, model/runtime notes, build outputs, Vite caches and captured process generations. The shipped runtime build gets only a scratch outDir override and retains its workspace bundling rules. It never empties the checkout dist. The heavy lock is `.cache/verify-heavy.lock` inside this checkout. Readiness requires actual product health, runtime model health, Helix health, web build/proxy and successful signup/signin. Startup failure keeps evidence and attempts cleanup.

## Drive the touched feature

```sh
.agents/skills/verify-vivid/verify feature first flue-<id>
.agents/skills/verify-vivid/verify browser first flue-<id>
.agents/skills/verify-vivid/verify feature document flue-<id>
.agents/skills/verify-vivid/verify browser document flue-<id>
.agents/skills/verify-vivid/verify feature devices flue-<id>
.agents/skills/verify-vivid/verify browser devices flue-<id>
```

`feature all` and `browser all` attempt every mapped feature. Missing browser recipes exit unsuccessfully with `no browser recipe`. Only the requested feature's journey can produce its verdict. HTTP uses Person cookies, public contracts/RPC and the real server gateway. WatchThread proves settlement. Browser uses the composer, Send and reload, records snapshots/screenshots and asserts semantic DOM. Tool checks table columns and rows. Document checks the tool-card element and expanded list item; the Artifact opener is blocked in this web client. Full document proof also requires the HTTP versioning recipe.

The repository workflow uses agent-browser on the selected host with a private namespace, session and profile. Read its installed core skill before use. Set `VIVID_VERIFY_BROWSER` and `VIVID_VERIFY_CHROME` when binaries are elsewhere. Browser processes are recorded from its private PID receipts. Close always runs in finally; cleanup retries retained receipts.

The devices journey uses public enrolment and decision RPCs with no model calls. A separately allowed installation holds the real native request stream. Requests appear only on Feed and in Settings; the browser recipe checks their absence in a Thread and on Home. Read [its feature file](features/devices.md) for scope, stream cleanup evidence and restart/native limitations. The Watch recipe checks real event delivery and its Feed card. The broader Feed recipe remains separate.

For Electron changes read the [desktop recipe](features/desktop.md), then run `.agents/skills/verify-vivid/verify desktop flue-<id>` on the devbox. It launches the built app and a private default browser under Xvfb against this disposable server. It drives email sign-in, Google handoff/Cancel, device connectivity and a model browser action, retains `desktop/` evidence and closes native processes in finally. Google grants, egress routing and OS-specific behavior retain the prerequisites in that recipe. Each repetition needs a fresh Launch.

## Android phone

For Android work, read [the phone feature](features/phone.md) and [Android setup](references/android.md). From the PC run `verify android provision <devbox-pick alias>`. It rebuilds empty snapshot-excluded SDK and AVD directories, boots headless and reports the observed serial. In the same host's proof checkout run Launch, Doctor, `verify phone thread <run>`, Doctor, then Cleanup. The phone command uses the existing synthetic account and `adb reverse` to this run's server. Its snapshots, screenshots, APK checksum and cleanup receipts stay under `<evidence>/phone/`. It proves idle navigation only.

## Evidence and cleanup

Evidence stays under `.cache/verify/flue-…/`. Include the feature file, exact head, working-tree status, model kind/id, host, per-feature HTTP/browser verdicts and evidence directory in the PR body. A screenshot proves its visible state only. Failed, blocked and plumbing-only runs remain unverified. For a blocked feature write `blocked: <reason>` and make unblocking its recipe the next task. A parent must obtain the different-family gate at the exact pushed head.

```sh
.agents/skills/verify-vivid/verify cleanup flue-<id>
ps -p <captured-pids> -o pid,ppid,args
docker ps -a --filter label=vivid.verify --format '{{.Names}} {{.Status}} {{.Ports}}'
```

Save cleanup audits beside evidence. Confirm captured generations exited, owned ports closed and all labelled containers and their anonymous volumes absent. Cleanup validates canonical paths and labels, stops captured generations only, removes private scratch and volumes, and retains evidence. Never kill by pattern. Delete any private remote key file after cleanup.

## Skill checks

Run all eight lifecycle regressions with `node --test .agents/skills/verify-vivid/scripts/recovery.test.mjs`. Fixtures use a separate temporary evidence root and are removed after tests. They never update the live current pointer. Format/lint with the skill's format.mjs and lint.mjs configs. These checks supplement the real runtime proof.

Manual public helpers are `sign-in`, `create-thread`, `chat`, `history` and `stop`. Use `/maintain-verification-skill` when contracts or controls change. Read [validation requirements](references/validation.md) before claiming completion.

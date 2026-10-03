# Grok Bot: machine infrastructure and product surface

2026-10-03: Historical Grok Bot evidence and Vivid mappings; Boat’s real-service proof supersedes the implementation context, while current Computer behavior and limits live in [docs/04](04-computer.md) and [docs/14](14-product-feature-set-and-grok-bot-parity.md); reference unknowns remain unknown.

**Evidence scope.** This is an artifact map of Grok Bot 0.30/0.39, not a product
review. `SandBoxService.proto` is treated as the machine wire spine; the 0.39
Electron main and renderer are used to distinguish calls from merely declared
RPCs; English i18n and the six named screenshots are used for user-visible
behavior. The 0.30 service-method inventory contains six services and 1,185
listed methods: Dashboard 621, GrokBot 106, BackgroundComposer 224, Ai 189,
Analytics 8, and SandBox 37 (`refs/grok-bot-0.30/surface/0.30.0-backend-service-methods.json:2-1198`).
That breadth is backend surface, not proof that every method is exposed in the
Grok Bot UI. Auth, Electron trust boundaries, design tokens, and motion are
already covered by `docs/16-grok-bot-auth-and-design-evidence.md:1-155`; this
document cites that report rather than repeating it.

I use four labels below:

| Label         | Meaning                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **Wire**      | A proto message or RPC proves that a contract exists, not who calls it or what the server does. |
| **Client**    | Recovered 0.39 main/renderer code shows the desktop using or presenting the contract.           |
| **Visible**   | User-facing copy, rendered UI, or a named screenshot shows what a person can see/do.            |
| **Inference** | A bounded interpretation of multiple anchors; it is not a server implementation fact.           |

## Executive model

Grok Bot has two different “computer” concepts. A cloud Sand box is brokered by
`EnsureSandBox` and exposes a gateway, VNC URL, terminal directory, and execution
credentials (`refs/grok-bot-0.30/protos/SandBoxService.proto:13-32`). A user
computer is a separately registered machine reached by a credentialed local-exec
bridge (`refs/grok-bot-0.30/protos/GrokBotService.proto:1334-1515`). The shipped
client presents the cloud machine as “Grok Bot’s Computer,” and the local machine
as “On your computer”/“Runs on your local computer” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:980-1043`; named screenshot `05-box-desktop-agent-data.png`).

The product is therefore not “a chatbot with an optional terminal.” It is a
roster of named, avatared Bots; each Bot has conversation state, background work,
skills/plugins, connectors, and access to a persistent shared computer, plus a
separate opt-in path to a person’s own computer. The roster and shared-machine
language are visible in the onboarding strings and settings (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:483-484,1878-1930,3817-3818`).

# Part A — machine infrastructure

## 1. What is a box?

### What the wire proves

`EnsureSandBoxRequest` contains only a paginated/reported GitHub repository list,
`has_more`, and an optional `access_error`; it contains no `agent_id`, `thread_id`,
`user_id`, or `team_id` (`refs/grok-bot-0.30/protos/SandBoxService.proto:13-17`).
The response identifies infrastructure (`cluster`, `tenant_id`, `pod_id`), gives a
`network_token`, `exec_daemon_auth_token`, `exec_daemon_url`, primary and fork VNC
URLs, `terminals_folder`, an optional image-update flag, and gateway URL/token
(`refs/grok-bot-0.30/protos/SandBoxService.proto:19-32`). **Inference:** this is a
remote pod-backed machine with a gateway/VNC plane and an execution-daemon plane;
the artifact does not settle whether the pod is a VM, container, or another
sandbox runtime (`refs/grok-bot-0.30/protos/SandBoxService.proto:19-31`). The 0.39 client actually
calls `ensureSandBox({})`, rejects an empty `gateway_url`, and turns the response
into a gateway connection plus primary/fork VNC proxy (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:153-241`). The name and repeated status-driven use make `Ensure` look like desired-state reconciliation—“make this account’s box usable”—rather than a caller-owned one-shot create, but that lifecycle ownership is **unknown — no artifact anchor** beyond the call shape and client behavior.

The same contract exposes `EnsureSandBoxWindow` with one `int32 window_index` and
the same `EnsureSandBoxResponse` (`refs/grok-bot-0.30/protos/SandBoxService.proto:34-36,602-603`).
The field is an index, not a time duration. The renderer separately models a
cloud computer as a set of VNC “monitors”/screens, with a monitor strip and
overflow menu (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:1084-1293`).

### Cardinality conclusion

**Visible/client:** multiple Bots can be presented against one “shared computer.”
The UI says “Open a Bot to update the shared computer,” “Open a Bot to reset the
shared computer,” and “Updates the computer your assistants share … All assistants
update together” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:820,1160,2063`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/settings.json:931`).
The renderer’s `ForeverBox` status is keyed by a Bot/box id and exposes one VNC
URL plus a `windows` array; running computer-use subagents become monitor entries
(`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m10-vnc.tsx:7844-8069,8263-8339`).

**Wire:** `ListSandBoxesRequest` does support source kinds `CLOUD`, `LOCAL`,
`AUTOMATION`, `USER`, `TEAM`, and `NAMED_AGENT`, each with a `source_id`
(`refs/grok-bot-0.30/protos/SandBoxService.proto:441-454`). That proves the backend
can index stores by several scopes. It does not establish that `EnsureSandBox`
creates one box per source, nor that a thread owns a box.

**Answer:** the shipped product’s ordinary cloud presentation is a shared
computer for the user’s Bots, not a per-thread desktop. The exact server
cardinality behind `EnsureSandBox`—one per account, team, Bot, or another tenant
policy—is **unknown — no artifact anchor**. `EnsureSandBoxWindow` is clearly an
indexed window/screen-oriented operation, but whether it means a desktop window,
a display, or another server-side window abstraction is **unknown — no artifact
anchor**. It is not evidenced as a time window.

## 2. Lifecycle: create, run, recreate, hibernate, upgrade

The public machine RPC set includes ordinary and admin recreate, force-recreate,
admin hibernate, run-state read, and upgrade scheduling (`refs/grok-bot-0.30/protos/SandBoxService.proto:38-68,323-332,381-439,601-639`).

| Operation             | Wire contract                                                                                                                                                                                                                                                                               | Client/visible consequence                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ensure/create or wake | `EnsureSandBox` returns the pod/gateway/VNC/exec bundle (`refs/grok-bot-0.30/protos/SandBoxService.proto:13-32`).                                                                                                                                                                           | The client maps `ABSENT` to `creating` and `HIBERNATED` to `waking`, then ensures the box (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:159-241`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea1-connectors-and-skills.ts:1630-1640`).              |
| Recreate/update       | `preserve_data`, `force`, and terminal-schedule acknowledgement; response is `started`, `reason`, `operation_id` (`refs/grok-bot-0.30/protos/SandBoxService.proto:38-48`).                                                                                                                  | The client sends `preserveData` and `force:false`, tracks the returned operation, and exposes “Update computer” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:261-303`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-otel-tracing.ts:2853-2870`). |
| Force recreate/reset  | The force request has GitHub installation/page/search fields in the 0.30 wire extraction, but the 0.39 client calls it with `{}` (`refs/grok-bot-0.30/protos/SandBoxService.proto:50-56`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:304-316`). | UI copy says reset rebuilds from the last saved snapshot and may lose very recent changes (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/settings.json:316,1070`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:2008`).                                       |
| Hibernate             | The only extracted hibernate RPC is `AdminHibernateSandBox(auth_id, flavor, force)` (`refs/grok-bot-0.30/protos/SandBoxService.proto:323-332`).                                                                                                                                             | The client has a sleeping/paused state and says the computer resumes automatically once available (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m10-vnc.tsx:7844-7875`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:2661-2664`).                                    |

`GetSandBoxRunState` takes repository settings and returns an opaque
`GetPassthroughPromptResponse state` plus optional image-update availability
(`refs/grok-bot-0.30/protos/SandBoxService.proto:381-388`). The renderer normalizes
known states into `pulling`, `running`, `local`, `starting`, `sleeping`, or `off`
when status data permits (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m10-vnc.tsx:7844-7875`).
The complete enum values and server transition rules are **unknown — no artifact
anchor**; the recovered client only directly names `ABSENT` and `HIBERNATED`.

A user-facing automatic hibernate policy is not proven. The explicit hibernate
RPC is admin-named and takes `auth_id`/`flavor`; automatic pause is mentioned in
away/routine copy, but no cloud hibernate trigger or wake policy is shown
(`refs/grok-bot-0.30/protos/SandBoxService.proto:323-332`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:178-182,1517-1520`).
**Trigger:** **unknown — no artifact anchor**. **Wake:** the client treats
`HIBERNATED` as “waking” and calls `EnsureSandBox`; the server’s wake condition
and whether it powers on, restores, or rehydrates the box are **unknown — no
artifact anchor** (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:159-241`).

## 3. Migration: what moves and what the client does

The wire stream is resumable: `WatchSandBoxMigrationRequest` carries an offset and
`include_finished`; each `SandBoxMigrationEvent` carries a phase, detail, time,
offset, and operation id (`refs/grok-bot-0.30/protos/SandBoxService.proto:362-379`).
The 0.39 client maps phases to `backing-up`, `creating`, `moving`, `cleaning-up`,
`wiping`, `done`, and `failed`, remembers offsets, retries dropped watches, and
broadcasts the current operation status (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:403-521`).

**Client-visible:** the progress copy explicitly says “backing up your data,”
“transferring your data,” and “starting the new computer”; the UI can continue in
the background, retry, or keep waiting (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:1563-1588,1999-2008`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:5308-5320`).

**Inference:** the operation moves a persistent data set from the old box/host
into a newly created box, while the desktop keeps a resumable progress relay and
reconnects to the new gateway. “Old box,” “new box,” and the exact transport are
not named in the event schema, so the physical placement and copy algorithm are
**unknown — no artifact anchor**. The phase names prove sequencing, not an
implementation.

## 4. Persistence: SandBoxStore versus the live filesystem

The store contract is object storage, not a POSIX API. Writes are requested by
relative path, SHA-256, size, conditional ETag/absence, and optional multipart
parts; the server returns presigned URLs and expiry times (`refs/grok-bot-0.30/protos/SandBoxService.proto:70-126`).
Multipart completion returns per-file success/failure and ETags, while reads return
presigned URLs; stat/list expose object metadata and cursors (`refs/grok-bot-0.30/protos/SandBoxService.proto:128-226`; `refs/grok-bot-0.30/protos/SandBoxService.proto:601-613`).
Admin snapshot/manifest/restore contracts expose entry counts, bytes, manifest
versions, hydration, and restore operation ids (`refs/grok-bot-0.30/protos/SandBoxService.proto:267-321`).

The strongest client anchor uses this store for transcript blobs: it prefixes
blob hashes with `blobs/`, asks `presignSandBoxStoreReads`, fetches the returned
URLs, and decodes the bytes as transcript bodies (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea3-updates-account-transport.ts:1164-1210`).
That is a side-channel object read, not execution against a mounted directory.
The cloud client’s `EnsureSandBoxResponse` gives execution a gateway and VNC/exec
endpoints, not a store mount (`refs/grok-bot-0.30/protos/SandBoxService.proto:19-32`).

The local dev recreate plane makes the distinction explicit: it first flushes the
box store, logs that “the mounted sand-data tree is the carrier” when flush is
unavailable, verifies `sand-data` after container replacement, and separately
supports `recreate-from-store` hydration (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-coordinator-ipc.ts:2460-2555,2690-2765`).
This is a dev fallback, not proof of the production server implementation.

**Conclusion for Vivid:** Grok’s evidence agrees with the Vivid domain rule that
the Computer’s ordinary POSIX disk is live truth and object storage may snapshot
it but is not the filesystem the agent executes against (`CONTEXT.md:117-127`).
Grok’s store is also used for transcript/blob side-channel reads. Whether the production cloud implementation
uses a mounted backing volume internally during snapshotting is **unknown — no
artifact anchor**; the product contract does not make object storage the live
POSIX disk.

## 5. Provisioning: setup manifests

A user/repository manifest request carries a repository identifier, repository
settings, optional write-check bypass, GitHub Enterprise application, and optional
team id (`refs/grok-bot-0.30/protos/SandBoxService.proto:487-493`). An assigned
manifest has `scope_kind`, `scope_id`, manifest id, revision, and entries; each
entry has an id, setup string, and optional check (`refs/grok-bot-0.30/protos/SandBoxService.proto:495-512`).
The fields prove that provisioning is declarative and scoped, but the exact
commands represented by `setup`/`check` are **unknown — no artifact anchor**.

Team manifests are a separate shape: manifest id, revision, ETag, entries, team id,
and `can_manage`; save/delete use an expected ETag (`refs/grok-bot-0.30/protos/SandBoxService.proto:514-540`).
Thus user/repository assignment is read through `ListSandSetupManifests`, while
team-owned definitions are listed and mutated through the team RPCs. Exact
precedence between repository, user, and team manifests is **unknown — no artifact
anchor**. The client’s plugin copy says Git credentials are set up on the box so
installed plugins can be fetched, which ties some provisioning to the box
filesystem (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:151-152`).

## 6. Local exec: the user’s own machine

The local-exec daemon is not the cloud box daemon. The server issues a credential
for a `machine_id`; the response contains an opaque credential, expiry, and
`server_authoritative` flag (`refs/grok-bot-0.30/protos/GrokBotService.proto:1334-1342`).
The daemon stores per-computer entries containing credential, machine id, expiry,
account scope, and authority (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:19-42`).

There are two channels:

1. **Box channel:** after `POST /sand-box/local-exec-connection` with the credential,
   the daemon receives a base URL/token/headers and uses SSE `GET /local-exec/requests`
   plus `POST /local-exec/responses`; the box channel adds `x-anyrun-network-token`
   when supplied (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:44-59`).
2. **Server-bridge channel:** a server-authoritative per-account connection uses
   Connect-RPC Watch/Poll/Submit methods with machine id, credential, hello,
   acknowledgement ids, and response frames (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:46-59,181-190`).

The request/response union is deliberately narrow: exec, upload, download,
approval retirement, cancel, and Apple Messages operations in; client/control,
file, file-error, messages-result/error out (`refs/grok-bot-0.30/protos/GrokBotService.proto:1410-1515`).
The daemon executes command/read/list/write resources inside a path-jailed local
root, transfers files up to 100 MiB, and checks standing/approval state before
use (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:192-219`). The product
labels this distinction plainly: “The Bot wants to run a command,” “Allow once,”
“Always allow,” “Never,” and “Runs on your local computer” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:1362-1423,1567-1672`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/shared.json:3-15`).

The credential is not the file-sealing key. A separate random 32-byte key is
handed by environment or parent IPC; AES-256-GCM seals daemon connection,
credential, supervisor-heartbeat, and update-lease JSON files, while the discovery
record remains plaintext with a non-secret key fingerprint (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:61-123`).
The user-computer hello advertises local root, terminals folder, standing,
supervision, variant, authority, and optional Messages capability
(`refs/grok-bot-0.30/protos/GrokBotService.proto:1344-1408`).

## 7. Team/admin control

The team API lists a member’s boxes by `team_id` and `user_id`, returning the
member’s user id/email/name and repeated pod records containing cluster, pod,
tenant, flavor, run state, image, timestamps, node, and failure reason
(`refs/grok-bot-0.30/protos/SandBoxService.proto:551-575`). A kill request names
team, user, pod, and cluster; the response reports killed/reason/deleted count
(`refs/grok-bot-0.30/protos/SandBoxService.proto:577-588`).

Host/store snapshot, restore, hibernate, recreate, migration watch, and agent
transcript inspection have `Admin` request names and generally require `auth_id`
and `flavor` (`refs/grok-bot-0.30/protos/SandBoxService.proto:58-68,228-379`).
That marks them as internal/admin surfaces; it is not, by itself, a complete ACL
proof. **Wire:** an authorized admin can inspect and terminate a member’s pod and
operate host/store recovery. **User-visible:** the ordinary client exposes
computer recovery/update language, not the member-pod admin roster
(`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:925,1969,2063`).
Who may invoke each admin method and whether the org can inspect file contents are
**unknown — no artifact anchor**.

## 8. What the unusual upgrade schedule actually schedules

The upgrade request is not a Bot routine. It accepts team id, default Bot mode,
cloud-agent PR filtering, global disable, and auto-create-on-first-PR-push flags;
the resulting schedule stores timezone, local time, recurrence, target image tag,
next fire, state, last completed image, and failure reason (`refs/grok-bot-0.30/protos/SandBoxService.proto:390-407`).
Schedule/cancel/reschedule return the schedule object (`refs/grok-bot-0.30/protos/SandBoxService.proto:413-438`).

The shipped client wires these calls as `getComputerUpgradeSchedule`,
`scheduleComputerUpgrade`, `rescheduleComputerUpgrade`, and
`cancelComputerUpgrade` (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-otel-tracing.ts:2872-2886`). Copy says “Automatic computer updates run at [local time] when a new image is available” and “Install the latest software … keep your files in place” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/settings.json:293-294,619-620`). It also says an active agent is paused at a safe point and resumed on the new computer, while installed apps/packages are removed (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/settings.json:334-335,931-932`).

**Answer:** it schedules a future **computer image/software upgrade** for the
shared machine, not a conversation job. It is account/team-scoped in the request
shape and applies to the assistants sharing that computer. Whether this is one
physical “personal machine” per account or a team-shared host is **unknown — no
artifact anchor**; the UI’s shared-computer copy establishes the product behavior,
not the deployment topology.

# Part B — product surface

## 1. Onboarding: the real sequence

The default sequence is `landing → meet → computer-demo → jobs → tools → create`;
role selection inserts `role`, and a feature flag can remove `create` for an
onboarding Bot (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:384-417`).
After sign-in, the hand-off waits for computer readiness, checks whether the
account is already onboarded, creates the configured teammate, marks onboarding
seen, and aborts if the account changes (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:5050-5188`).

| Step              | What the user sees/does                                                                                                                                                                                                                                                | What is collected or not collected                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `landing`         | Sign-in card; existing signed-in users advance (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:4980-5015`).                                                                                                                            | Account auth; auth details are covered in the prior report (`docs/16-grok-bot-auth-and-design-evidence.md:7-17`).                                                                                                                                                  |
| `meet`            | Animated first meeting/composer scene (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:4003-4297`).                                                                                                                                     | No durable profile field is evidenced in this scene; exact prompt semantics are **unknown — no artifact anchor**.                                                                                                                                                  |
| `computer-demo`   | Demonstrates an agent working at a computer; the component is a dedicated step (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:3388-3800,5250-5272`).                                                                                  | Demonstration, not a user machine pairing; exact backend work is **unknown — no artifact anchor**.                                                                                                                                                                 |
| `jobs`            | “Give each Bot a job”; three animated examples are Invoice Chaser, Weekly Standup, and Sales Forecast (`named screenshot 01-give-each-bot-a-job.png`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:3906-4002`).                      | Example jobs are a mental model, not a submitted job form; no job value is collected here.                                                                                                                                                                         |
| `role` (optional) | Job-role cards such as engineering, design, marketing, support, product, finance, recruiting, sales, productivity (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:2925-3181`).                                                         | Selected role id is stored in onboarding state (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:642-930`).                                                                                                                          |
| `tools`           | “What do you use every day?” search and multi-select (`named screenshot 02-what-do-you-use-every-day.png`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:4480-4680`).                                                                 | `dailyTools` is the selected tool/logo ids; the list is role-prioritized (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:4480-4610`).                                                                                              |
| `create`          | “Create your first Bot”; name field, avatar color/shape, suggested Bot cards/templates (`named screenshot 03-create-your-first-bot.png`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:2780-2840,2240-2400`).                         | Draft contains name, description/template suggestion, color, shape, and picked template id; the create call passes role and daily tools as teammate context (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:2240-2290,5135-5188`). |
| `hand-off`        | Computer readiness/progress, retry, and “I’m done, continue” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:5298-5320`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/chunk-computer-screen-preview-DTkUFUSk.tsx:1-30`). | Provisioning of the onboarding Bot or teammate; the server-side meaning of “hand-off” beyond this flow is **unknown — no artifact anchor**.                                                                                                                        |

The screenshot shorthand “two-question flow” is incomplete: the shipped default is
an animated product tour plus job examples, optional role, daily-tool selection,
then Bot creation and computer hand-off. The exact answer payload for `meet` is
**unknown — no artifact anchor**.

## 2. The Bot/agent model versus Vivid

A Bot is a first-class durable record with id, name, description, title, avatar
shape/color, avatar URL/version, created/updated times, harness, role, optional
visibility/team id, and owner flag (`refs/grok-bot-0.30/protos/GrokBotService.proto:804-838`).
Creation accepts name/description/title/avatar data, harness (`BOX` or `TEMPORAL`),
optional kickstart/introduction suppression, purpose, and origin (`refs/grok-bot-0.30/protos/GrokBotService.proto:798-818`).
The client can list personal plus team agents, and the UI explicitly supports
“Your Bots,” hidden Bots, sections, delete, rename, avatar editing, and “Add or
create another Bot” (`refs/grok-bot-0.30/protos/GrokBotService.proto:851-854`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:1878-1930,2041-2044`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:2-15,211-220`).

Bots differ by identity/profile, role/purpose, harness, visibility/team ownership,
attached skills/plugins/connectors, routines, and conversation history. The
wire model supports Bot-to-Bot messaging and room member turns
(`refs/grok-bot-0.30/protos/GrokBotService.proto:1263-1276,1600-1623`), while the
renderer exposes “Messaging another assistant” and “Waiting on another Bot”
(`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/shared.json:472-474,879-895`).

This is deliberately unlike Vivid’s stated “one person, one Vivid”: Vivid’s rule
says one surface, no roster, no agent configuration, with capabilities arriving
inside the thread (`docs/01-principle.md:5-28`). Grok is evidence for persistent
identity, readable state, and capability-backed work—not for copying a Bot roster
into Vivid.

## 3. Feature inventory

| Area                | Evidence-backed surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Boundary and status                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation        | Durable transcript commit/list/watch, generations/cursors, live activity/client state, presence, attachments, send/status/interrupt, widgets, reactions, and feedback are all in the GrokBot proto (`refs/grok-bot-0.30/protos/GrokBotService.proto:651-793,1170-1302`). The client calls send, interrupt, widget resolution, local-tool permission, virtual-card approval, and auto-review resolution (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-coordinator-ipc.ts:1578-1726`).                       | **Visible:** empty/loading/error/retry, “Ask anything, or drop a file,” reactions, replies, widgets, unread and working states (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:3-15,1499-1500,1760-1815`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m14-modules.tsx:6438-6605`).                                  |
| Tasks/jobs          | Background Composer inventory includes async follow-ups, pending follow-up list/update/delete/reorder/submit-now/edit, and provider-specific Slack/GitHub/Linear follow-up streams (`refs/grok-bot-0.30/surface/0.30.0-backend-service-methods.json:733-958`; `refs/grok-bot-0.30/protos/BackgroundComposerService.proto:4030-4062,4756-4865,7526-7534`).                                                                                                                                                                        | **Visible:** “Background task,” “Async tasks,” and “The Bot wants to run a task” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:200-220`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:1770-1775`). Exact task scheduler ownership is **unknown — no artifact anchor**.                        |
| Routines/scheduling | Renderer has a Routines surface with cadence, time zone, triggers, run history, pause/resume, manual run, webhooks, Git events, Slack/Teams/Linear/PagerDuty/Sentry events, and a five-minute minimum (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:85-160,430-465,946-952,1799-1807,2520-2523`).                                                                                                                                                                                              | **Visible:** routines are recurring tasks a Bot runs on a schedule; event-triggered runs and webhook auth are user concepts (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:85-160,2520-2523`). Direct routine CRUD RPCs are not in the extracted GrokBot service; the implementation path is **unknown — no artifact anchor**. |
| Plugins/connectors  | Dashboard wire has MCP server metadata, HTTP/SSE/stdio config, OAuth tokens, tool definitions, plugin install modes, and user/team install APIs (`refs/grok-bot-0.30/protos/DashboardService.proto:1870-2077,2680-2830,6680-6895`; `refs/grok-bot-0.30/protos/DashboardService.proto:7360-7388,7754-7791`).                                                                                                                                                                                                                      | **Visible/client:** a Plugins marketplace/modal has categories, search, Featured, Team plugins, Add, installed state, plugin details, connectors, and skills (`named screenshot 04-plugins-modal.png`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/views/chunk-view-CVwfsDIQ.tsx:280-408,2920-3440,5934-6266`).                                       |
| Box desktop         | Cloud status has a VNC URL, optional windows, pull progress, handoff, and computer-use action stream (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m14-modules.tsx:7845-7940`; `refs/grok-bot-0.30/protos/GrokBotService.proto:700-793`).                                                                                                                                                                                                                                                                           | **Visible:** open computer, monitor strip, VNC webviews, held-frame connecting state, crashed state, and keyboard/focus navigation (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:695-966,971-1293,2133-2360`).                                                                                                              |
| Files/data          | Attachments can be staged/read/downloaded; transcript blobs use presigned store reads; the renderer previews PDF, image, video, spreadsheet, diagram, Markdown, and JSON-like file types (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-otel-tracing.ts:3000-3070`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:390-456,500-680,1090-1100`).                                                                                                                               | **Visible:** Files panel, file cards, “Browse files,” “Download,” and the box’s `agent-data` filesystem (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:2161-2162,3613-3614`; named screenshots `05-box-desktop-agent-data.png` and `06-box-desktop-agent-data-2.png`).                                                           |
| Voice               | `MintSandVoiceCallSecret` accepts a model and returns short-lived client secret, expiry, model, and WebSocket URL (`refs/grok-bot-0.30/protos/SandBoxService.proto:590-599`). The main exposes `mintVoiceCallCredential`; renderer has voice-loop lifecycle, microphone, realtime connection, mute/hang-up, and transcript cards (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea1-machines-and-prefs.ts:454-463`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m11-voice.tsx:97-895,1292-2154`). | **Visible:** Start voice call, voice input, call-in-progress, transcript, microphone states (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:47-60,630-650`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:697-700`). Exact realtime provider behavior is **unknown — no artifact anchor**.         |
| Sharing/teams       | Bot templates have public/team visibility, versions, blob URLs, import/export, and create-from-template (`refs/grok-bot-0.30/protos/GrokBotService.proto:964-1168`). Rooms support member turns and shared-room ids; Slack has install/connect/reinstall/uninstall contracts (`refs/grok-bot-0.30/protos/GrokBotService.proto:1560-1685`).                                                                                                                                                                                       | **Visible:** share as template, public/team-only, shared room, invite/approve requests, team agents, Slack connection (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:289-290,1905-1910,3203-3234`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:1418-1420,1908-1910`).                         |
| Settings            | Account/team, usage/billing, appearance, notifications, computer label/list, egress, Chrome cookie import, local permissions, auto-review rules, microphone, updates, reset/recovery are renderer surfaces (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/settings.json:1-1100`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/chunk-computer-pane-D8F4SO4L.tsx:1146-2073`).                                                                                                                   | **Visible:** settings are an overlay/destination in the desktop; admin host/store controls remain internal (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/app/m15-components.tsx:2480-2580`; `refs/grok-bot-0.30/protos/SandBoxService.proto:228-379`).                                                                                                 |

## 4. Plugins: what they are, how installation works, what they reach

A plugin is a bundle, not merely one connector. Its wire record contains
repository/ref metadata, tags/logo/publisher/marketplace, and repeated skills,
subagents, hooks, rules, MCP servers, commands, variables, lifecycle/install mode,
and client-version constraints (`refs/grok-bot-0.30/protos/DashboardService.proto:2762-2804`).
The renderer groups a plugin with its connectors and displays separate Skills and
Connectors sections (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/views/chunk-view-CVwfsDIQ.tsx:3860-3915,6099-6266`).

The installed/effective model distinguishes user, team-default, and team-required;
user installs can be enabled/disabled, pinned, configured with variables, or
uninstalled, while team-required installs cannot be removed by the user
(`refs/grok-bot-0.30/protos/DashboardService.proto:6712-6735,6883-6895`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/views/chunk-view-CVwfsDIQ.tsx:4020-4060`).
The shipped main fetches effective plugins, calls `InstallUserPlugin` only after
checking current installs, and exposes install/update/remove/uninstall operations
through the desktop edge (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea6-mcp-definitions.ts:1130-1238`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-otel-tracing.ts:2924-2945`).

A connector is an MCP server/tool relationship inside or beside that bundle. HTTP
and SSE servers execute on the backend; stdio servers run on Grok Bot’s computer,
according to the client’s explicit error/copy (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea6-mcp-definitions.ts:1620-1638`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/shared.json:895-896`).
OAuth is a separate HTTPS authorization and loopback callback flow, already mapped
in the auth/design report (`docs/16-grok-bot-auth-and-design-evidence.md:15-17`).
Thus a plugin can reach the box through stdio/MCP, backend services through
HTTP/SSE, and external accounts through stored OAuth/configuration; the complete
capability allowlist and each plugin’s actual permissions are **unknown — no
artifact anchor**.

## 5. The box in the product: what a person sees

The product gives the person a remote desktop, not a filesystem tree as its only
abstraction. The fullscreen modal uses Electron VNC webviews with a 1280×800
stage, a held JPEG frame while connecting, a live/failed state, and a monitor strip
for additional screens (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:1-80,695-966,1084-1293`).
A screen can be opened from the compact computer preview; “Open” and “Open the
screen” are explicit controls (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:728-730,815-816`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/chunk-computer-screen-preview-DTkUFUSk.tsx:430-600`).

The compact preview also shows an attention banner over the screen. It can say
that a Bot needs you and offers Skip or “I’m done, continue”; the full modal has a
handoff banner and monitor focus selection (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/chunk-computer-screen-preview-DTkUFUSk.tsx:479-575`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:2112-2131,2270-2530`).

The screenshots show the crucial presentation choice. `05-box-desktop-agent-data.png`
shows a Linux desktop with Thunar open at `/home/box/agent-data/`, containing
`agents`, `agent-transcripts`, `managed-skills`, `plugin-skills`, `transcript-publish`,
`workflows`, `box-secrets.json`, `gateway.json`, `settings.json`, and related
runtime files. `06-box-desktop-agent-data-2.png` shows the same file manager
scrolled to `search-index.db`, `settings.json`, `source-map.json`, and
`teach-queue-key.json`, with the Linux taskbar. These screenshots are named
artifacts, not proof that every file is a supported user concept.

The renderer makes the higher-level framing explicit: the computer is a VNC
screen with status, preview, cursor/action overlays, attention, handoff, and
recording—not a generic “open SSH” control (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/chunk-computer-screen-preview-DTkUFUSk.tsx:32-110,250-430`).
The user can see and operate the desktop, see a Bot’s cursor/actions, and inspect
ordinary files through the desktop. Which box files are supported, hidden, or
safe to edit is **unknown — no artifact anchor**.

## 6. Teach-a-task and hand-off

The evidence supports both. The fullscreen top bar has a “Teach a task” action
(`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:1445-1560`;
`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:1813-1814`).
The recording overlay arms a Bot, starts/stops recording with an entry point,
shows elapsed time, and offers Stop and save or Discard; its copy says the Bot
learns the steps and can run them again (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:1622-2046`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:178-180`).

The screen preview has recording state, cursor/action subscription, and “Stop &
save”; the user-facing strings say “is learning your steps” (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/chunk-computer-screen-preview-DTkUFUSk.tsx:100-230,430-600`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:1813-1814`).
The recording UI proves capture and save controls, not the learned procedure’s
schema, approval policy, replay reliability, or where it is stored: those are
**unknown — no artifact anchor**.

Handoff is also a wire concept: `EndGrokBotBoxHandoff` takes agent id, request id,
and a trigger and returns dispatch/workflow status (`refs/grok-bot-0.30/protos/GrokBotService.proto:1560-1568`).
The renderer has base-handoff and monitor-handoff resolvers, “Take over the
computer,” and “I’m done, continue” states (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:2112-2131`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:3188-3189`).
This establishes a product hand-off between Bot activity and human screen use.
Whether “hand-off” also means the cloud Bot delegates to the user-computer
bridge in every case is **unknown — no artifact anchor**.

# Part C — implications for Vivid

## Take

| Copy                                                                       | Why the evidence supports it                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep live POSIX disk separate from snapshot/object storage.                | Grok’s store contract is presigned object I/O and manifest/snapshot machinery, while execution is brokered through gateway/VNC and the dev plane names the mounted data tree as the carrier (`refs/grok-bot-0.30/protos/SandBoxService.proto:70-126,267-321`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-coordinator-ipc.ts:2491-2555`). |
| Make lifecycle states explicit and resumable.                              | Run-state mapping, migration offsets, operation ids, progress, retry, and background continuation are all visible client concerns (`~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:159-241,403-521`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:1563-1588`).                            |
| Present the Computer as a screen plus honest state, not as infrastructure. | Grok gives a VNC preview, full desktop, monitor strip, attention banner, cursor actions, and teach recording (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:695-966,971-1293,1622-2046`).                                                                                                                                     |
| Use two explicit execution boundaries for cloud and local machines.        | The local-exec protocol separates box SSE from server-authoritative user-computer Connect-RPC and seals local daemon state (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:44-59,125-219`).                                                                                                                                                                   |
| Put approvals and outcomes in the thread.                                  | Grok’s user-visible command/task/connected-service cards, approval states, and retry/cancel controls show the capability event without requiring the person to understand RPCs (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/chat.json:632-650,1362-1423,1567-1672`).                                                                      |

## Reject

| Reject for one person + one Vivid                                            | Why it belongs to Grok’s multi-Bot/team product instead                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Bot roster, per-Bot settings, hidden Bots, sections, Bot-to-Bot messaging. | Grok’s data model and UI explicitly support many named agents, team agents, hidden sidebar state, and agent messaging (`refs/grok-bot-0.30/protos/GrokBotService.proto:804-854,1263-1276`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:1878-1930`).    |
| A first-class Plugins/Skills/Connectors destination.                         | Grok needs marketplace/install/team-required/plugin-variable machinery; Vivid’s principle says capabilities arrive in-thread and engineering categories stay underneath (`refs/grok-bot-0.30/protos/DashboardService.proto:2762-2804,6712-6895`; `docs/01-principle.md:18-28`).         |
| Team/admin pod management in the main product.                               | Member pod scans, kill-by-cluster/pod, host status, snapshot and admin transcript RPCs are backend/operator controls (`refs/grok-bot-0.30/protos/SandBoxService.proto:228-379,551-588`).                                                                                                |
| Treat computer-image upgrades as routines.                                   | The separate upgrade schedule targets an image and pauses/resumes assistants; it is not a user job or recurring Bot task (`refs/grok-bot-0.30/protos/SandBoxService.proto:390-438`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/settings.json:334-335,931-932`). |
| Copy the onboarding’s multiple-Bot framing.                                  | “Give each Bot a job” and three Bot examples are optimized for a team of assistants (`named screenshot 01-give-each-bot-a-job.png`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:3817-3818`).                                                           |

## Open questions for Vivid

1. ~~Does one Person own one persistent Computer, or does each Thread get its own machine?~~
   **Resolved on re-inspection (7 Sep 2026) — the evidence does settle this.**

   `EnsureSandBoxRequest` carries **only** `repos`, `has_more`, `access_error` — GitHub repositories
   and nothing else (`refs/grok-bot-0.30/protos/SandBoxService.proto:13-17`). There is no thread id,
   no user id, no project id. The box is therefore scoped **implicitly to the authenticated
   principal**: identity arrives via the bearer token and `x-cursor-team-id` header, never as a
   request field (see `docs/16-grok-bot-auth-and-design-evidence.md`, "Backend request
   authentication"). This is the same shape Vivid's own `listProjects` now uses — the scope is not an
   argument, so it cannot be supplied.

   The subdivision is `EnsureSandBoxWindowRequest`, whose entire payload is
   `int32 window_index = 2` (`refs/grok-bot-0.30/protos/SandBoxService.proto:34-36`). A "window" is an
   **indexed slot inside one box**, not a separate machine. `RecreateSandBoxRequest.preserve_data`
   confirms the box is a durable thing that survives recreation
   (`refs/grok-bot-0.30/protos/SandBoxService.proto:38-42`).

   **Conclusion:** one persistent box per authenticated principal, subdivided by indexed windows —
   not a machine per thread. This maps directly onto `CONTEXT.md`: **Computer** = the box (one per
   Person), **Work area** = a window (a bounded context inside it). Grok Bot's model supports
   Vivid's existing distinction rather than contradicting it.

   **Caveat — wire contract is not product.** The 0.39 reconstruction contains **no** reference to
   `ensureSandBoxWindow`, `windowIndex`, or `window_index` anywhere in `src-main` or `src-0.39`.
   The RPC exists in the 0.30 wire contract but the shipped 0.39 client does not call it. Whether
   windows are still used in 0.39, or were superseded by the fork-desktop path
   (`fork_vnc_base_url`), is **unknown — no artifact anchor**.

2. Is the Computer’s disk always live and durable, or can the runtime execute
   against a restored clone during migration? Grok’s public contract settles the
   product distinction but not the production implementation (`refs/grok-bot-0.30/protos/SandBoxService.proto:70-126`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-coordinator-ipc.ts:2491-2555`).
3. Which events wake a sleeping machine, what is the idle policy, and what is the
   catch-up guarantee? The client shows waking and a one-hour routine catch-up
   message, but not the scheduler/server rule (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/core.json:2661-2664`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:1970-1978`).
4. Should human takeover be a screen-level mode, a durable Approval/Input request,
   or a handoff to a local Computer capability? Grok shows screen handoff and a
   separate local-computer bridge but does not define their product relationship
   (`refs/grok-bot-0.30/protos/GrokBotService.proto:1334-1515,1560-1568`).
5. What is the smallest safe Computer presentation for a non-technical person:
   live desktop, curated files/artifacts, or both? Grok shows both a full desktop
   and raw `agent-data` files in the screenshots, but does not state the safety
   boundary for editing them (`named screenshots 05-box-desktop-agent-data.png`
   and `06-box-desktop-agent-data-2.png`).

# Unknowns

- Exact cloud box cardinality—per user, team, Bot, thread, or another tenant
  policy—is **unknown — no artifact anchor** (`refs/grok-bot-0.30/protos/SandBoxService.proto:13-17`).
- Exact semantics of `EnsureSandBoxWindow.window_index` are **unknown — no artifact
  anchor** beyond an indexed window contract and renderer screen/monitor UI
  (`refs/grok-bot-0.30/protos/SandBoxService.proto:34-36`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:1084-1293`).
- Complete `SandBoxRunState` enum and server lifecycle transitions are **unknown —
  no artifact anchor** (`refs/grok-bot-0.30/protos/SandBoxService.proto:381-388`).
- Automatic hibernation trigger, wake condition, and resource-retention behavior
  are **unknown — no artifact anchor** (`refs/grok-bot-0.30/protos/SandBoxService.proto:323-332`; `~/refs/grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts:159-241`).
- Production migration transport and exact old/new host topology are **unknown —
  no artifact anchor** (`refs/grok-bot-0.30/protos/SandBoxService.proto:362-379`).
- Exact production relationship between SandBoxStore objects, snapshots, mounted
  volumes, and the executing filesystem is **unknown — no artifact anchor**;
  evidence only establishes object side-channel plus snapshot/restore behavior
  (`refs/grok-bot-0.30/protos/SandBoxService.proto:70-126,267-321`).
- Meaning and precedence of `SandSetupManifestEntry.setup` and `.check` are
  **unknown — no artifact anchor** (`refs/grok-bot-0.30/protos/SandBoxService.proto:495-506`).
- Exact ACLs and file-content authority of team/admin box operations are **unknown
  — no artifact anchor** (`refs/grok-bot-0.30/protos/SandBoxService.proto:228-379,551-588`).
- Internal credential format, server verification, and desktop minting implementation
  are **unknown — no artifact anchor** (`refs/grok-bot-0.30/local-exec-daemon/ANALYSIS.md:221-231`).
- Exact learned-task schema, replay engine, storage, and safety policy are **unknown
  — no artifact anchor** (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/box-desktop-modal.tsx:1622-2046`).
- Exact relationship between box handoff and user-computer handoff is **unknown —
  no artifact anchor** (`refs/grok-bot-0.30/protos/GrokBotService.proto:1334-1515,1560-1568`).
- Complete routine CRUD/backend ownership is **unknown — no artifact anchor**;
  renderer strings and Background Composer follow-up contracts prove scheduling
  surfaces, not the routine persistence API (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/i18n/default/agents.json:85-160,2520-2523`; `refs/grok-bot-0.30/protos/BackgroundComposerService.proto:4030-4062`).
- Complete plugin/connector capability and permission matrix is **unknown — no
  artifact anchor** beyond plugin primitives, MCP transports, and approval/config
  plumbing (`refs/grok-bot-0.30/protos/DashboardService.proto:2762-2804,1870-2077`).
- Exact `meet` onboarding answer payload is **unknown — no artifact anchor**;
  only the rendered sequence and collected role/tools/Bot draft are evidenced
  (`~/refs/grok-bot-0.39-reconstructed/frontend/src-0.39/side/onboarding-flow.tsx:384-417,642-930,5135-5188`).

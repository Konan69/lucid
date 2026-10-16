# OpenMuse reference: what to borrow

2026-10-03: Historical borrowing plan; built Approvals, Input requests, Run records, Executor-owned Integration credentials, and Boat supersede its Vivid gap claims; current truth is in domain READMEs and [docs/14](14-product-feature-set-and-grok-bot-parity.md), and Watches and the Feed own proactivity; reminders await the clock app.

OpenMuse (`CopilotKit/OpenMuse`, MIT) is a single-owner personal-assistant template: Hono server,
CopilotKit runtime over AG-UI, Expo client, PGlite/PostgreSQL, a Playwright browser worker, and an
optional Docker "computer". This note records the mechanisms worth adapting into Vivid, with exact
source locations, and what must change on the way in.

- **Checkout:** `refs/openmuse` (ignored), commit `ef8f608`, 22 Sep 2026. Line numbers refer to it.
- **License:** MIT. Copied code keeps the MIT notice and names its origin in JSDoc; identifiers take
  Vivid's vocabulary (see "Borrowed code takes Vivid's names" in `CLAUDE.md`).
- **Reading rule:** borrow the _behavior and invariants_. Their implementation style — one JSONB
  `records` table, `zod`, string status fields, optional-field bags, Promise classes, `setInterval`
  polling, a catch-all `AppError(message, status)` — does not meet Vivid's standard and is not ported.

## Summary

| #   | Mechanism                                              | OpenMuse source                                                                                     | Vivid target                             | Priority |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------- |
| 1   | Hash-bound, expiring approval with atomic claim        | `apps/server/src/actions.ts`, `apps/server/src/db.ts:77-94`, `packages/domain/src/index.ts:117-156` | `apps/server/src/approvals` (empty)      | P0       |
| 2   | Outcome-unknown for uncertain external writes          | `packages/integrations/src/google.ts:19-27,551-606`, `apps/server/src/db.ts:90-94`                  | Approvals + Connections                  | P0       |
| 3   | Leased background work with heartbeat and recovery     | `apps/server/src/engine/worker.ts`                                                                  | Watch events + Thread Runs               | P0       |
| 4   | Typed input request that resumes the work              | `apps/server/src/engine/service.ts:306-330,844-864`                                                 | `apps/server/src/inputs` (empty)         | P0       |
| 5   | Tool-result journal (replay-safe tools after re-lease) | `apps/server/src/engine/model.ts:24-95`                                                             | Flue tool adapter / Runs                 | P1       |
| 6   | Idempotent, keyed notifications + outcome publication  | `apps/server/src/engine/service.ts:73-116,578-588,749-807`                                          | `apps/server/src/notifications`          | P1       |
| 7   | Browser egress guard (public-unicast only)             | `apps/worker/src/network.ts`, `apps/worker/src/browser.ts:215-235`                                  | `packages/computer` egress               | P0       |
| 8   | Persistent Chromium profile per session + takeover     | `apps/worker/src/browser.ts`, `apps/server/src/browser-console.ts`                                  | `packages/computer/desktop`              | P1       |
| 9   | Hardened command container + command receipts          | `apps/server/src/computer.ts:441-750`, `apps/computer/Dockerfile`                                   | `packages/computer/machine`              | P1       |
| 10  | Short-lived signed file URLs                           | `apps/server/src/auth.ts:42-55`, `apps/server/src/files.ts:50-52`                                   | Artifacts                                | P1       |
| 11  | Credential envelope encryption                         | `packages/integrations/src/vault.ts`                                                                | `apps/server/src/connections`            | P1       |
| 12  | Google adapter: ETag-guarded calendar writes           | `packages/integrations/src/google.ts:523-548,787-816`                                               | `apps/server/src/connections/google`     | P1       |
| 13  | PDF inspect/fill with script stripping                 | `packages/integrations/src/pdf.ts:93-153`, `apps/server/src/files.ts`                               | Artifacts / Library                      | P2       |
| 14  | Document job (attachment → form → reply for approval)  | `apps/server/src/engine/service.ts:808-899`                                                         | An event-backed workflow, once 1–4 exist | P2       |
| 15  | Page watch with change dedupe                          | `apps/server/src/engine/service.ts:359-440,900-997`                                                 | `apps/server/src/watches` events         | P2       |
| 16  | Client message queue that never auto-resends           | `apps/mobile/src/conversation-queue.ts`                                                             | `packages/client`                        | P2       |
| 17  | Inline result cards linked to durable records          | `apps/mobile/src/thread-artifacts.tsx`, `browser-tool-card.tsx`, `mail-tool-card.tsx`               | Thread UI (web + mobile)                 | P1       |
| 18  | Suggestions with source evidence                       | `apps/server/src/engine/service.ts:441-577`                                                         | Today                                    | P2       |

P0 is the trust loop Vivid lacks entirely: Approval, Input request, Run lease, and honest
uncertainty. Everything else rides on it.

## 1. Approval bound to a content hash, with expiry and an atomic claim

**What it does.** A proposed consequential action (`email.send`, `calendar.create|update|delete`)
is decoded, optionally _prepared_ (the adapter reads the live target and records its version), and
stored as `awaiting_review` with:

- `hash` = SHA-256 of `{input, connection, target, targetVersion}` (`actions.ts:77-86`). The
  decision request must echo the hash; a mismatch is rejected ("This proposal changed…",
  `actions.ts:110-111`). The Person approves exactly what they saw.
- `expiresAt` = created + 30 min (`actions.ts:88`). Expired reviews are CAS-moved to `expired`
  (`actions.ts:121-135`, and by the worker at `worker.ts:86-106`).
- `connectionId` + `account` captured at proposal time. Approval is refused if the connected account
  or connection id changed since (`actions.ts:136-149`). Reconnecting invalidates pending work.
- Optional idempotency key → deterministic id + `insertIfAbsent`, so a retried proposal returns the
  same record (`actions.ts:45-52,90-98`).
- Approval of an action that belongs to a task requires the task to be `running` or
  `waiting_approval` (`actions.ts:113-120`); cancelling a task auto-denies its pending action
  (`service.ts:291-295`).

The claim is a single conditional `UPDATE` (`db.ts:77-89`): status must still be `awaiting_review`,
not expired, and (for execution) the owning task must still be live. Two concurrent approvals cannot
both execute. Every transition writes an activity entry (`actions.ts:192-201`).

States (`packages/domain/src/index.ts:142-150`): `awaiting_review → executing → succeeded | failed |
outcome_unknown`, or `awaiting_review → denied | cancelled | expired`.

**Vivid mapping.** `docs/10`/`CLAUDE.md` define Approval as "authorization for one consequential
action, preserving action, risk, rationale, scope, and decision". OpenMuse has action + decision but
no risk, rationale, or scope, and no decider identity.

**Adapt.**

- Model `Approval` as a `Schema.TaggedUnion` over the states above; `Pending` carries `digest`,
  `expiresAt`, `connectionId`; `Executing`, `Succeeded`, `Failed`, `OutcomeUnknown`, `Denied`,
  `Expired` carry only what each state has. No optional `result?`/`error?` bag.
- The action payload is its own tagged union per Connection capability, decoded once at ingress.
- Add `risk`, `rationale`, `scope`, the deciding **Person** and their **Membership**; authorize the
  decision against Company permissions, not a shared owner string.
- Keep: digest echo, expiry, connection pinning, idempotent proposal, conditional claim in one SQL
  statement (Drizzle `update … where … returning`), auto-deny on Run cancellation.
- Failures become tagged errors (`ApprovalChanged`, `ApprovalExpired`, `ConnectionChanged`,
  `RunNotActive`), not `AppError(message, 409)`.

## 2. Outcome-unknown: never silently retry an uncertain external write

**What it does.** The Google client classifies failures by whether the write might have landed
(`google.ts:551-606`): credential problems before dispatch are definite; a network error, timeout,
5xx/408, or unreadable response on a **write** throws `OutcomeUnknownError`
(`google.ts:19-27`). Reads get ordinary errors. `ActionService` maps that to status
`outcome_unknown` (`actions.ts:177-187`). On boot, any action still `executing` becomes
`outcome_unknown` ("Server restarted during execution…", `db.ts:90-94`). Retrying a task whose
action is not `succeeded` is refused (`service.ts:246-253`). The Person reconciles with the
provider, then starts fresh.

**Adapt.** A `ConnectionWriteOutcomeUnknown` tagged error returned by every Connection write
adapter, an `OutcomeUnknown` Approval state, and a startup reconciliation Effect. This is small,
cheap, and prevents duplicate emails and events. P0.

## 3. Leased background work: CAS lease, heartbeat, guard, checkpoint

**What it does** (`apps/server/src/engine/worker.ts`):

- A poller (1 s) selects due work: `queued`, `scheduled` with `nextRunAt ≤ now`, `running` with an
  expired lease (crash recovery), or `waiting_approval` whose action resolved; max 3 at once
  (`worker.ts:64-115`).
- Claim is a compare-and-swap on `{status, leaseId, leaseUntil}` that sets a fresh `leaseId`,
  `leaseUntil = now + 60 s`, and increments `attempts` (`worker.ts:116-132`).
- Heartbeat every `lease/3` extends the lease with CAS; losing it aborts the run's `AbortSignal`
  (`worker.ts:171-187`).
- The handler receives `guard()` (re-reads and throws `LostLeaseError` if paused, cancelled, or
  taken over), `checkpoint(patch)` (CAS-guarded partial update), and `event(kind, …)` (append-only
  run events) (`worker.ts:136-164`).
- Lost lease → back to `queued`; other failure → `failed` with an error event; each attempt writes a
  `runs` record `running → finished | interrupted | failed` (`worker.ts:165-240`).
- Pause/resume/cancel/retry are explicit transitions with preconditions (`service.ts:231-305`).

Task states: `queued, running, waiting_approval, waiting_input, scheduled, paused, succeeded,
failed, cancelled` (`packages/domain/src/agent.ts:3-12`).

**Vivid mapping.** This is Vivid's **Run**: one bounded attempt to advance a Thread.
Product Run records live in `apps/server/src/threads`; Flue owns conversation execution and its durable lifecycle.

**Adapt.**

- `Run` state as a `Schema.TaggedUnion`; lease fields exist only on `Running`.
- Claim with `SELECT … FOR UPDATE SKIP LOCKED` or a conditional `UPDATE … RETURNING` on real
  columns, not JSONB containment.
- Replace `setInterval` polling and the heartbeat timer with an Effect `Schedule`/`Fiber`; abort via
  fiber interruption instead of an `AbortController` map.
- `guard`/`checkpoint`/`event` become one `RunContext` service scoped to the Run.
- Tests drive a `TestClock`, never sleeps.

## 4. Typed input request that resumes the work

**What it does.** A handler returns `status: "waiting_input"` with a `question` and a machine-readable
list of what is missing (`service.ts:844-864` stores `missingFields`). `answer()` accepts only from
`waiting_input`, merges structured `fields` into the task input and the free-text answer into state,
and CAS-moves the task to `queued` (`service.ts:306-330`). The worker picks it up; completed steps
are skipped because their results were checkpointed (`service.ts:813-835,866-876`).

**Adapt.** Vivid's **Input request** is a durable record, not a status string: it belongs to a Run,
names the Thread, carries a schema for the expected answer, and is answered by a Person with
permission. The answer decodes against that schema before the Run is requeued. OpenMuse's
single `question` string is too weak to render a form. Take the "resume by requeue, skip
checkpointed steps" behavior.

## 5. Tool-result journal for replay-safe tool calls

**What it does** (`apps/server/src/engine/model.ts:24-95`). Inside a leased run, tool calls are
serialized (providers may request parallel tools; checkpoints must stay ordered, `model.ts:31-43`).
`cached(name, args, op)` keys a result by `sha256(name:args)`, stores it in `task.state.operations`,
and checkpoints before returning. If the run is re-leased after a crash, an identical tool call
returns the stored result instead of repeating the side effect. After the run has an outcome
(waiting or finished), further tool calls return `{paused: true}` (`model.ts:55-62`).

**Adapt.** Worth keeping for side-effecting tools that are not behind an Approval. Check first how
Flue replays a turn after a crash (`pnpm exec flue docs …`) — the journal belongs at Vivid's tool
adapter boundary and must not duplicate Flue's own transcript.

## 6. Keyed notifications and outcome publication

**What it does.** `notify(title, body, taskId, key)` derives the notification id from a semantic
key and uses `insertIfAbsent` (`service.ts:578-588`), so the same event never notifies twice. Keys
encode the event: `task-done:<id>`, `task-error:<id>:<attempts>`, `input:<id>:<hash(question)>`,
`review:<actionId>`, `monitor:<id>:<contentHash>` (`service.ts:749-807,979`). A maintenance pass
every 60 s re-publishes outcomes for all tasks (`service.ts:73-80`), which is what makes publication
survive a crash between "commit outcome" and "notify".

**Adapt.** Vivid notifications (`apps/server/src/notifications`, 22 lines) should take the
semantic-key idempotency with a unique index. Replace the full-table rescan with an outbox written
in the same transaction as the Run/Approval state change.

## 7. Browser egress guard

**What it does.** `validatePublicUrl` (`apps/worker/src/network.ts:46-96`) allows only
`http(s)` on ports 80/443, no userinfo, no `localhost|local|internal|home|lan` suffixes, and
requires **every** resolved address to be global unicast. `isPublicIp` (`network.ts:8-42`) blocks
IPv4 private, loopback, CGNAT, link-local, multicast, documentation, and benchmark ranges, and
restricts IPv6 to `2000::/3` minus documentation/6to4/Teredo. The browser context routes every
request through it and aborts failures; WebSockets are closed; popups closed; dialogs dismissed
(`apps/worker/src/browser.ts:215-235`).

**Vivid mapping.** `docs/04-computer.md` already requires that egress through the Person's laptop
"cannot reach the LAN". This is a ready, tested classifier for that rule.

**Adapt.** Port `isPublicIp` and the URL check nearly verbatim as a pure module with its tests
(`tests/browser.test.ts`). Route-level checks alone leave a DNS-rebinding gap, because the browser
resolves the name again; OpenMuse closes it with an egress proxy that connects only to the
already-validated address, never a second lookup (`apps/worker/src/proxy.ts`). Vivid's egress
path, including the laptop relay, needs the same property.

## 8. Persistent browser profile and take-control console

**What it does.** One `launchPersistentContext` profile directory per session
(`browser.ts:152-190`), cookies restored from saved state, all operations on a session serialized
(`browser.ts:65-85`), PDF downloads captured to a per-session folder with failure records
(`browser.ts:235-250,361-380`, `apps/worker/src/downloads.ts`). "Take control" is a server-rendered
page (`apps/server/src/browser-console.ts`) that shows a PNG screenshot refreshed every 2 s and
posts clicks (scaled to 1280×800), typed text, keys, and scroll. It never runs remote page code in
the app document.

**Vivid mapping.** Vivid's target is a whole desktop over VNC with a synced Chrome profile
(`docs/04-computer.md`), so the screenshot console is not the destination. It is a credible
**interim** Computer: real, persistent, and takeable, shippable before the desktop exists.

**Adapt.** Take the per-session serialization, download capture, and dismiss-popups/dialogs policy.
Do not take the 2 s screenshot polling for the final UI — it is a continuously repainting loop,
which `CLAUDE.md` forbids; a VNC stream or event-driven frames replace it.

## 9. Hardened command container with receipts

**What it does.** `docker container create` flags (`apps/server/src/computer.ts:465-500`):
`--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --network none
--ipc private --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 --restart no`, a
`noexec` 64 MB `/tmp`, and a named volume at `/workspace`. Each command
(`computer.ts:591-750`):

- gets an idempotent receipt id and writes a `running` receipt **before** executing
  (`computer.ts:600-630`); a replayed id with a different command is rejected;
- runs under `/usr/bin/timeout --kill-after=2s 30s bash --noprofile --norc -c` with output
  truncation;
- is guarded by a per-owner lease; if the lease was lost before start, the receipt becomes
  `interrupted`;
- on timeout or a lost Docker client, **stops the whole container**, because `docker exec` cannot be
  cancelled reliably, and the lease is not released until the stop is confirmed.

**Vivid mapping.** Vivid wants a whole machine, not a 30-second sandbox; OpenMuse's limits are the
opposite thesis. Two ideas still transfer to `packages/computer/machine`: receipt-before-execute
with an idempotency key, and "kill the whole unit when you cannot prove a command stopped".

## 10. Short-lived signed file URLs

**What it does.** `auth.sign(owner, path)` appends an HMAC-SHA256 over `owner\npath\nexpires` with a
15-minute expiry (`apps/server/src/auth.ts:42-55`); files are only ever returned with a signed URL
(`files.ts:50-55`). Files are written `0600` with `wx` so an id cannot be overwritten
(`files.ts:44-46`).

**Adapt.** Artifacts and Library downloads need this for native clients that cannot attach auth
headers. Sign over Company + Artifact id + version, read the key with `Config.redacted`.

## 11. Credential envelope encryption

**What it does** (`packages/integrations/src/vault.ts`). AES-256-GCM, 12-byte nonce, fixed AAD
`openmuse:credential:v1`, serialized `v1.nonce.tag.ciphertext` in base64url, strict decoding
(canonical base64, exact lengths, no extra segments). Refresh tokens are updated with a guard on
`connectionId` so a token from a replaced connection cannot overwrite the new one
(`db.ts:105-111`).

**Adapt.** Vivid currently stores Google `access_token` and `refresh_token` as plaintext `text`
columns (`apps/server/src/connections/tables.ts:9-10`). Adopt the envelope, read the key through
`Config.redacted`, and bind the AAD to the Connection id (not a global constant) so a ciphertext
cannot be moved between Connections. Also take the refresh guard: a refreshed token only lands if
the Connection id still matches. P1, arguably P0 before any shared deployment.

## 12. Google adapter details

Beyond the write-uncertainty rule (§2): calendar updates and deletes read the event, require an ETag,
and send `If-Match` so a stale review cannot overwrite a changed event
(`google.ts:523-548,787-816`); requests use `redirect: "error"` and a 30 s timeout
(`google.ts:564-575`); attachment size caps are explicit (`google.ts:15-17`). Vivid already has a
Google Connection (`apps/server/src/connections/google`); compare against these points rather than
porting the file.

## 13. PDF inspection and filling

`inspectPdf` reports page count and fields typed `text | checkbox | unsupported`
(`packages/integrations/src/pdf.ts:73-99`). `fillPdf` rejects unknown fields and wrong value types,
caps text length, strips `OpenAction`/`AA`/`A`/`JS`/`JavaScript` from every object
(`pdf.ts:101-116`), and regenerates appearances with Helvetica (`pdf.ts:117-153`). Import caps are
10 MB and 500 pages, and names are control-character-stripped (`files.ts:24-31`). The script
stripping is worth taking into Library ingestion regardless of form filling.

## 14. Document job as a worked example of 1–4 together

`service.ts:808-899` chains everything: find the attachment → checkpoint → if no field values,
return an Input request listing the supported fields → fill a new copy (original kept, linked by
`parentId`) → checkpoint → propose `email.send` with the filled file attached → `waiting_approval`.
Each step checkpoints so a re-lease resumes at the right step. Use it as the acceptance scenario for
Vivid's Run + Input request + Approval slice; as a product feature it can run in response to an app event.

## 15. Page watch with change dedupe

`observe` (`service.ts:900-997`) normalizes page text, hashes it, and matches `change` (hash
differs), `contains`, or `price_below` (a USD regex, `service.ts:993-996`). Level-triggered
conditions notify only on the transition into matched (`service.ts:935-936`); change notifications
are keyed by content hash (`service.ts:979`). The watch reschedules itself as a `scheduled` task.
Vivid currently reacts to Executor app events through Watches. Scheduled public-page checks are unavailable.

## 16. Client message queue

`apps/mobile/src/conversation-queue.ts` is an external store (`subscribe`/`getSnapshot`, suitable
for `useSyncExternalStore`) holding messages typed while a response streams. It sends them one at a
time; on failure it pauses and **never resends** the failed message (`conversation-queue.ts:38-41`).
Vivid's Flue runtime already admits messages mid-response (`docs/14`), so take only the
"visible pending list + pause on failure, no implicit resend" behavior into `packages/client`.
The composer keeps the draft on stop (`apps/mobile/src/chat.tsx:307-316`).

## 17. Inline result cards linked to durable records

Tool results render as cards in the Thread and link to the saved record rather than being
re-described in prose: `FileThreadCard` and `TaskThreadCard` (`apps/mobile/src/thread-artifacts.tsx`),
the browser card with its live/running state (`browser-tool-card.tsx`), and mail results
(`mail-tool-card.tsx`). Borrow the pattern — every Run output is an Artifact with a card that opens
it — not the components; Vivid's UI is built to its own design language (`docs/08`).

## 18. Suggestions with evidence

`refreshIdeas` (`service.ts:441-524`) proposes work with a reason and source excerpts, dedupes by
content-derived id, and retires suggestions whose source was already answered or completed. The
matching is keyword regex (`/form|permission|complete|fill|sign/`, `/coffee|meet|available/`), which
is a demo, not a model. Keep the shape — `reason` + `evidence[]` + accept/edit/dismiss, retire when
obsolete — for Today; generate the suggestions with Vivid itself.

## Not worth borrowing

- **Storage model.** One `records(owner, kind, id, data jsonb)` table (`apps/server/src/db.ts:130-132`)
  with JSONB-containment CAS. No schema, no migrations, no relations. Vivid uses Drizzle tables.
- **Identity.** One owner behind a shared access key (`auth.ts:15-40`). No Person, Company, or
  Membership. Every mechanism above must be re-scoped to Company tenancy.
- **Thread history.** Live mode depends on CopilotKit Intelligence, a separate paid service outside
  the MIT license. Flue owns this in Vivid.
- **Computer thesis.** A network-less 30-second container is "pieces of a computer"; see
  `docs/04-computer.md`.
- **Polling everywhere.** 1 s worker tick, 60 s maintenance rescan of every table, 2 s screenshot
  refresh.
- **Error model.** `AppError(message, httpStatus)` and string-matched `outcomeUnknown` flags.
- **Feature sprawl.** Separate Ideas, Goals, Tracking, Finance, and Documents screens; Vivid's first
  screen is the Thread (`docs/01-principle.md`).
- **Finance CSV** (`apps/server/src/engine/finance.ts`) and the **OpenBot** adapter
  (`packages/backends/src/openbot.ts`): demos without a Vivid use.

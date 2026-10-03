# Integrations at scale: Executor from our fork, with tenants, on our Postgres

**Status:** decision and plan, 3 October 2026. It replaces the deployment part of
[One product](22-one-product.md) "Connections: Executor" ("runs beside the server as one more local
process"). The product rules there still hold: a Connection maps to an Executor account plus the
profile that selects it, the model sees `find_tools`, `use_tool` and `connect`, and Vivid stores the
mapping and never a credential.

Evidence is the upstream Executor source, branch `v2` at commit `2732ab3`. Paths below are relative
to that repository: `SH` is `apps/hosted/self-host`, `H` is `apps/hosted/server`, `C` is
`apps/hosted/cloud`, `SDK` is `packages/sdk`, `AD` is `packages/app-data`. A claim marked
**unverified** was read from source and not yet run.

## The decision

1. Vivid runs Executor's **hosted** shape, built from **our fork**. We do not use the local shape in
   production, and we do not buy Executor Cloud.
2. Executor becomes a **tenant-aware service**. Its tenant is the owner of a Connection: a Person for
   a personal Integration, a Company for a shared one. Vivid's server provisions each tenant; no human
   ever signs in to Executor, and no Person ever sees the word organization.
3. Its product database moves to **our PostgreSQL server, in a database of its own**. The embedded
   database is a starting point, not the end state.
4. Vivid's side stays in one file, `apps/server/src/connections/executor.ts`. Its `ExecutorService`
   interface is the seam; the transport behind it changes.
5. Two operations wait: resuming an approved tool call and cancelling a pending connection. Vivid's
   own Approval gates a consequential action before Executor is called, and a pending connection
   expires.

## What Executor v2 is

One SDK and app runtime, shipped three ways.

| Shape     | Tenancy                                             | State                                                | Instances           |
| --------- | --------------------------------------------------- | ---------------------------------------------------- | ------------------- |
| Local     | none; the caller names the owner on each call       | files on one machine                                 | one process         |
| Self-host | exactly one organization                            | one volume: embedded Postgres, Git, builds, app data | one container       |
| Cloud     | many organizations; free to 3 members, then per seat | external Postgres, object store, Durable Objects    | scales horizontally |

Self-host and Cloud serve the same HTTP API under `/api/organizations/{organization}`. Local serves a
different one (`/v1/...`, `/dashboard/api/...`), which is what Vivid's adapter spoke until now.

Why self-host is one container (`SH/README.md`, "Data and updates"):

- The product database is PGlite, stored inside a Durable Object's SQLite file on the volume
  (`SH/src/implementation/workerd/pglite-filesystem.ts:41`, `SH/src/worker.ts:84`).
- Git repositories, retained builds, per-app data and workflow journals are local files
  (`SH/native/main.go:472`, `SH/scripts/package-runtime.ts:200-221`).
- The Go host takes an exclusive lock on the volume and refuses a second owner (`SH/native/main.go:195`).
- Organization creation is switched off and sign-in requires exactly one organization
  (`SH/src/implementation/auth-options.ts:56`, `SH/src/implementation/registration.ts:70`).

The shared persistence layer already speaks PostgreSQL. `makeExecutorStorage` takes a `SqlClient` with
provider `postgresql` on both hosts; self-host hands it PGlite and Cloud hands it a real connection
(`SDK/src/implementation/storage.ts:12`, `C/src/infrastructure/executor.ts:100`). Setting
`DATABASE_URL` on today's self-host image does nothing, because the Go host does not forward it and
the worker constructs PGlite explicitly (`SH/native/main.go:86`).

## How Vivid's model maps onto it

| Vivid                                   | Executor                                              |
| --------------------------------------- | ----------------------------------------------------- |
| Connection owner: `Personal(person)`    | one organization for that Person                      |
| Connection owner: `Shared(company)`     | one organization for that Company                     |
| Vivid's server                          | a service principal that may act for any organization |
| Connection                              | one profile plus the account it selects, on one app   |
| The acting Person                       | attribution on the call; never an Executor member     |
| Integration (catalogue entry)           | app                                                   |

A Person's Integrations are theirs. They connect Gmail once and it works wherever they work: in
their own space and inside any Company they belong to, because the Connection is owned by the Person,
not by the place. A Company's shared Integrations are the Company's and stay behind when a Person
leaves. This is the ownership [One product](22-one-product.md) already defines
(`Personal(person) | Shared(company)`); Executor's organization is only where each owner's accounts
are stored. It is plumbing. It never appears in a string a Person or the model reads, and a Person
with no Company never meets the idea.

Vivid keeps the mapping from owner to Executor organization, and the organization's id is the opaque
one Executor issues. A Person id or Company id is never used as an Executor identity, key or storage
name. Identity, tenancy and attribution stay separate, as everywhere in Vivid.

Executor has no service principal today. API keys belong to a human, and a profile takes its subject
from the key's owner (`H/src/implementation/api-keys.ts:66`, `H/src/implementation/access.ts:130`).
Until stage C, Vivid holds one key in one organization and keeps owners apart itself: one profile per
Connection, and only that Connection's stored references are ever sent. Executor lists "per-person
account selection" as later work; this is the same idea done on Vivid's side.

## Stages

| Stage | What changes                                                                 | Size | Needed now               |
| ----- | ---------------------------------------------------------------------------- | ---- | ------------------------ |
| A     | Self-host image built from our fork, on Railway, with a volume               | S    | yes                      |
| A′    | Vivid's adapter rewritten to the hosted API                                  | M    | yes                      |
| B     | Product and auth database on our PostgreSQL through `DATABASE_URL`           | M    | soon                     |
| C     | Many organizations, provisioned and used through a service key               | M    | soon                     |
| D     | Stateless API with more than one replica                                     | L    | no, beyond today's size  |
| E     | App runner as its own scaled service                                         | M-L  | no, beyond today's size  |

**A. Our image on Railway.** No source change. An image service, a volume at `/app/data`, a public
domain (browser sign-in for an account lands on Executor's origin), health check `/health` with a
120-second start, one replica. Keys are generated on first boot and live on the volume.

**A′. The adapter.** Every route moves under the organization path. Route-by-route mapping, from the
adapter's own calls:

- catalogue, install, import, app read and delete, profile create and reconcile, tool list, tool
  call, connection create, read and submit, OAuth setup, start and complete, account delete: each has
  a hosted equivalent with a compatible response.
- No equivalent: app copy, list apps by owner, connection cancel, tool-call resume. Copy and list are
  replaced by one app per Integration in the organization, read from the organization inventory.
- `owner` and `subject` are no longer sent. Ownership is the organization in the path.
- OAuth: Executor chooses the redirect address and ignores one supplied per request. A
  deployment-wide `EXECUTOR_OAUTH_CALLBACK_URL` sets it, so it is pointed at Vivid's own callback.
  The provider then returns the Person to Vivid, and Vivid finishes with
  `POST .../connections/{id}/oauth/complete {callbackUrl}` under its key, which is the shape
  `completeSignIn` already has. Executor's own callback page is not used: it requires an Executor
  browser session, which no Person has.
- Destructive tools: a tool whose app declares approval answers `409 ToolApprovalRequired` with no
  request to resume and no parameter, role or profile switch that lets a key caller proceed. Until
  the fork lets the service principal state that Vivid's Approval was given, those tools cannot run.
  Reads and ordinary writes run.
- Four new failure tags need a home in `ExecutorFailure`: `OAuthRenewalFailed`, `AppProviderFailed`,
  `ToolListingTimedOut`, `BuildMemoryExceeded`.

**B. Our PostgreSQL.** Executor gets its own database and its own role on the PostgreSQL server
Vivid already runs: one server to operate and pay for, two databases. They cannot share one. Executor
and Vivid both use Better Auth, so both own tables named `user`, `session` and `organization`, and
each runs its own migrations. Separate databases also keep the rule that library-owned state is never
mirrored into app tables: Vivid reads Executor only through its API, never through SQL. In the fork: forward `DATABASE_URL` through the Go host, give the worker a
`PgClient` in place of PGlite, point Better Auth's store at the same database, and run migrations and
first-administrator setup under a lock (their correctness today relies on PGlite having one
connection, `SH/src/implementation/registration.ts:165`). Files: `SH/src/worker.ts`,
`SH/src/database.ts`, `SH/src/implementation/auth-database.ts`, `SH/native/main.go`. Risk: whether
workerd's sockets carry a Postgres connection the way the Cloud Worker's do. Git, builds and app data
stay on the volume.

**C. Tenants.** In the fork: a service key that is not a human; an idempotent endpoint that creates an
organization for a Connection owner (a Person or a Company) and runs its defaults; authorization that lets the service act in any
organization while recording the attributed Person as the profile subject. Remove the three
single-organization guards. Touches `H/src/contracts/auth.ts`, `H/src/implementation/api-keys.ts`,
`H/src/implementation/access.ts`, self-host registration, and Vivid's adapter. The risk to design
against is confusing principal with tenant; that is why the three identities stay separate.

**D. Replicas.** Beyond the database, each of these must become shared before two instances are
correct:

- Git repositories: one authoritative backend that keeps expected-revision conflict semantics.
- Retained builds and blobs: a shared object store; local copies become caches.
- Reactivity: revisions and subscriptions are in process memory (`packages/reactivity`).
- Schedules: every instance polls, and startup recovery interrupts every running row; it needs
  leadership or leases (`SDK/src/implementation/schedules.ts:463`).
- Per-app data and workflow journals: Durable Object SQLite on local disk. No PostgreSQL adapter
  exists for `AD`.

**E. Runner.** The SDK already has the remote seams (`SDK/src/implementation/remote-app-runner.ts`,
`workerd-client.ts`), and Cloud already separates its compiler and app-data workers. The smallest
route to D keeps one authoritative runtime behind those seams and puts stateless API replicas in
front, so E starts before D finishes.

D and E are written down so the earlier stages do not close them off. They are not scheduled.

## What the pilot proved

Run against the published image `executor-selfhost:2.0.0-beta.8` in a disposable container, with one
API key and no browser. The image is built from an older commit than the source read above, so
source-only claims stay marked.

- Setup, organization and key creation work over HTTP alone.
- Catalogue (5,533 entries), install, import of an MCP server by address, tool list, tool call,
  connection by API key, and deletion of profile, account and app all work with the key.
- Two profiles on one app held two different accounts. A call names its profile; with none it fails
  (`AccountRequired`) and never falls back to another account.
- The `subject` a caller sends on a profile is ignored and replaced by the key's owner, and a profile
  can be re-pointed at any account in the organization. So before stage C, isolation between owners
  is Vivid's to enforce: it sends only the references stored on the Connection.
- Memory: about 0.8 GB at start and 1.0 GB idle; it was killed at a 1 GB limit and ran at 2 GB.
  Volume after setup: 87 MB.
- Not proven: a completed OAuth sign-in with a real provider, and a live approval-declared call.

## What one instance costs us until D

- A restart or redeploy interrupts Integrations for its duration.
- Capacity grows by a larger machine only.

Executor mostly waits on other services' networks, so one instance carries many concurrent calls.
That is an expectation from the design, **unverified** by measurement.

## Risks

- **Licence.** The upstream tree has no root licence. Two components carry MIT files; nothing states
  the terms for the hosted product or the SDK. Running a modified multi-tenant build needs that
  settled with upstream before it carries anything we cannot move.
- **Drift.** 43 of upstream's last 100 commits touch `apps/hosted`. Keep fork changes in adapters and
  the auth seam, keep upstream's protocols, and rebase in small batches.
- **No import.** Local data cannot be moved into the hosted shape. Accounts are reconnected and apps
  reinstalled at the cutover.

## Order of work

1. Stage A on Railway, from the fork.
2. Stage A′, proven against a disposable instance by a `.live.test.ts` per behaviour.
3. Cut Vivid over; reconnect accounts.
4. Stage B, then stage C.

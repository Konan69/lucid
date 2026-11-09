# Infrastructure

2026-10-03: The current local stack below supersedes the beta.76 resource proposal preserved later in this file; current feature evidence lives in [docs/14](14-product-feature-set-and-grok-bot-parity.md).

## Runtime host transition

[Runtime cells](27-runtime-cells.md) is the chosen architecture. Each Person gets one celld
cell with a native Pi Durable Harness over Durable Object SQLite. celld owns activation,
ownership, and idle lifecycle; Pi owns tasks, queues, deduplication, wait, abort, and restart.
PostgreSQL keeps auth, Company/Membership, Thread metadata, Runs, Library, and other product
records. The native host and memory migrations open in `apps/cells/src/main.ts` (`Person`).
The runtime uses `openDurableObjectSqliteStorage` (`packages/agent/runtime/src/cell.ts`,
`openCell`). `scripts/migrate.mjs` owns only server auth and product migrations.

Alchemy starts the native Worker locally and declares the hosted fleet (`alchemy.run.ts`,
`localStack`; `infra/cells.ts`, `railwayCells`). The verifier also deploys this Worker to
its disposable native fleet (`.agents/skills/verify-vivid/scripts/cells.mjs`, `startCells`).
These source paths do not establish a production deployment or authorize one.

## Local cell graph

```text
pnpm infra:dev
  ├─ Docker: PostgreSQL 18 → 127.0.0.1:55433
  ├─ ordered Drizzle migrations: server auth → server product
  ├─ Command.Dev: native celld Worker → 127.0.0.1:5173
  ├─ Command.Dev: application server → 127.0.0.1:8787
  └─ Command.Dev: Vite web proxy → 127.0.0.1:5178
```

Alchemy `2.0.0-beta.81` owns the local resources through `alchemy.run.ts`, with only Command and
Docker providers registered. There is no AWS provider or emulator in the running stack.

Do not go back to Alchemy beta.79 against state that beta.81 has written. beta.81 marks a resource
whose name was taken over from a renamed one (`adoptionBlocked: "migrated-fqn"` in its state) and
skips recovery for it; beta.79 does not know the mark, keeps the same state version, and would
recover and then delete the renamed resource's predecessor.
PostgreSQL uses database/user/password `vivid` and the named volume
`vivid-postgres-local-data`. `infra/database.ts` is the database seam and returns a `Redacted`
URL. The server's migrations remain auth then product (`scripts/migrate.mjs`). Native Pi SQLite
opens inside the cell; it has no runtime PostgreSQL migration owner or `DATABASE_URL` requirement
(`packages/agent/runtime/src/cell.ts`, `openCell`).

`preview` remains disabled. `production` selects `infra/railway.ts` (`railwayResources`), which
calls `railwayCells` in `infra/cells.ts` for the two celld 0.6.2 nodes and retained Railway bucket.
The application server receives their private URLs. Local development keeps the Command/Docker
graph above. [Runtime cells](27-runtime-cells.md) describes the request and wake paths.

History. Helix was removed from personal memory. Its service and volume remain retained for
migration in `infra/railway.ts` (`railwayResources`). The health reported for the old services
on 3 October 2026 does not prove the cell fleet.

### Optional server settings and required capabilities

Inventory of optional capability settings in `apps/server/src`.
This records decisions only. It does not change configuration or deployment behavior.
Recheck with `rg -n 'optionalSetting|Config\.option|Config\.withDefault' apps/server/src`.
Test and live-proof settings are excluded from product capability requirements.

| Setting                                | Owner                                  | Decision and reason                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                           | `config.ts`                            | Make required. Auth callbacks and update asset addresses require the real public origin. A loopback default conceals a missing deployment value.                                                                       |
| `VIVID_WEB_DIST`                       | `config.ts`, `http/static.ts`          | Genuinely optional for a server behind Vite, which serves the web app. Require it in the production composition that owns the web files. Absence currently installs no static routes.                                  |
| `VIVID_MOBILE_UPDATES`                 | `config.ts`, `updates/routes.ts`       | Make required in a production composition that serves the phone. Absence currently removes update routes and silently strands installed binaries. A development server with no published export can genuinely omit it. |
| Selected provider key in decisions     | `decisions/model.ts`                   | Make required when `VIVID_DECISIONS=on`. An enabled capability must not compose as `Unconfigured`. Titles require the selected provider key independently. Keep the explicit off state.                                |
| `VIVID_OTLP_URL`, `VIVID_OTLP_HEADERS` | `config.ts`, `observability/export.ts` | Genuinely optional as one pair. Product operations run without remote telemetry. A partial pair is already a startup error.                                                                                            |
| `VIVID_ENVIRONMENT`                    | `config.ts`                            | Genuinely optional. Labels telemetry without enabling a capability.                                                                                                                                                    |
| `VIVID_BUILD_COMMIT`                   | `config.ts`                            | Genuinely optional. Settings can honestly show an unnamed build. The Docker image supplies a commit for releases.                                                                                                      |
| `PORT`, `HOST`                         | `config.ts`                            | Genuinely optional overrides. The local listener still exists at the defined default address and port. Deployment must supply its reachable listener.                                                                  |
| `VIVID_BOAT_ORG`                       | `computers/boat/transport.ts`          | Genuinely optional. Personal Boat accounts use their own wallet. Organization billing supplies the organization explicitly.                                                                                            |
| `VIVID_BOAT_SIZE`                      | `computers/boat/transport.ts`          | Genuinely optional tuning. Absence selects Boat's default size and preserves Computer creation.                                                                                                                        |
| `VIVID_BOAT_LIFETIME_SECONDS`          | `computers/boat/transport.ts`          | Genuinely optional tuning. Absence selects the defined 3600-second lifetime. Zero explicitly requests no expiry.                                                                                                       |
| `VIVID_BOAT_MACHINE`                   | `computers/boat/transport.ts`          | Genuinely optional adoption. Absence creates a Computer from the required template. Presence binds an existing machine for the single-owner installation.                                                              |
| `VIVID_THREAD_TITLE_MODEL`             | `threads/model.ts`                     | Genuinely optional model override. The required gateway key and default model preserve background completion.                                                                                                          |

The other defaulted controls are `VIVID_DECISIONS`, `VIVID_DECISION_MODEL`
and `VIVID_EXECUTOR_PUBLIC_ONLY`.
They do not retain an `Option` in the composed service. The decisions flag deliberately
switches an experimental capability off. The remaining controls select a model, restrict
an Integration catalogue, or tune a deadline. Their absence preserves their defined behavior.
`computers/tests/proof.ts` also accepts optional live machine and organization selectors.
Those select a proof target and do not configure a running product.

### Deploying to production

Keep the server at one Railway replica until desktop presence is shared and browse requests route to the replica holding the socket.

The server builds from `main` when a push changes a watched input (`infra/railway.ts`,
`builtFromMain`, `serverInputs`). Its image includes the cell workspace and exports the phone
update. Before the new server takes traffic, its pre-deploy command applies auth and product
migrations, then publishes the Worker (`infra/railway.ts`, `railwayResources`;
`apps/cells/scripts/build.mjs`, `main`). The celld node services use the pinned image and load
the published Worker; they are not separate repository builds. A docs-only push does not match
the server's watched inputs.

Nothing in the stack sees a push before Railway builds it, so the gate that `git push` runs is the
only thing that keeps a failing tree out of production. Judge a deploy by Railway's deployment
status and `/health`.

`node scripts/infra-verify.mjs` checks the server and runtime images against their workspace
dependency closures. It requires install-time manifests before `pnpm install` and production
workspace trees before the build uses them. It follows local tsconfig `extends`, project
references, explicit `files`, and literal module imports from copied packages' build configs.
It checks those inputs against Dockerfile `COPY`, `.dockerignore`, and the Railway watch lists
in `infra/railway.ts`.

The verifier does not execute configs or follow computed filesystem reads. Examples include
`path.resolve(__dirname, '..', '..')` in `apps/mobile/metro.config.cjs` and the paths built with
`NodePath.join` for `copyFileSync` in `apps/mobile/app.config.ts`. When a config reads a computed
path, keep its target inside a copied tree or add the target to the Dockerfile `COPY` and the
image's Railway watch list by hand. A passing verifier cannot prove that such a target is present.

`pnpm infra:deploy --yes` is now only for a change to the stack itself: a service, a variable, a
volume, a watch path. It needs `RAILWAY_API_TOKEN` for the personal Railway account, and is run
from a clean checkout of current `main`. A checkout from before 7 October 2026 still declares an
uploaded working tree; run from one, the provider disconnects both services from the repository
and deletes their triggers (`alchemy/src/Railway/ServiceProvider.ts`, `clearDeploymentTriggers`).

It reads its settings from `.env.production` in that checkout, never from `.env`. `.env` is a
developer's local file; a deploy that read it once sent production a model with no key and no
Executor key. `.env.production` is ignored by Git and holds the production values of the names in
`.env.example`; the deploy stops if the file is missing. A variable left out of the file is not
removed from a Railway service that already has it; delete it there with `railway variable delete`.

Known gap, Alchemy `2.0.0-beta.79`: the Railway provider waits about fifty seconds for a deployment
(`alchemy/src/Railway/ServiceProvider.ts`, ten tries five seconds apart), and an image build takes
about three minutes. The command therefore reports `ServiceDeployPending` and exits non-zero while
the build goes on and succeeds on Railway. Two consequences:

- Judge a deploy by Railway's deployment status and `/health`, not by the command's exit code.
- A service the tool still records as "replacing" gets one more generated public domain on every
  run, and the plan caps domains per service. After each deploy, delete every server domain except
  the first one, which `PUBLIC_URL` uses. Remove this step when the provider waits for the build.

### Running the stack's own deploy

Since the services build from the repository, the deploy uploads nothing. On 7 October 2026 it ran
from the developer's PC in eighteen seconds. Before that it uploaded each service's build context,
which a home connection reset part-way, and was run from the developer's Boat machine for that
reason; that route is no longer needed.

1. Fast-forward a clean checkout to `main`. Any checkout serves: none holds the state (see
   [Where the stack's state lives](#where-the-stacks-state-lives)).
2. Give the run `RAILWAY_API_TOKEN`, `GITHUB_TOKEN`, `ALCHEMY_STATE_URL` and `ALCHEMY_STATE_TOKEN`
   in its environment. They are never typed into a command line and never printed.
3. Run `alchemy plan --stage production --env-file <file>` and read it, as "Before a production
   deploy" says. Then the same with `deploy ... --yes`. That run was made from an export of the
   committed tree (`git archive HEAD`) with the checkout's `node_modules` one directory above it
   and `.alchemy` linked in, as the uploads needed; whether the checkout itself now serves was
   not tried.
4. Delete the extra generated server domain, then test a sign-in on the real origin. `/health`
   answers 200 even while `PUBLIC_URL` holds the wrong domain and every new sign-in is refused; a
   deployment reads that variable when it starts, so if the sign-in is refused, redeploy the
   server after the domain is gone.

### Where the stack's state lives

Since 16 October 2026 the production stack's Alchemy state is in Alchemy's own Cloudflare state
store, not in a checkout. The store is the `alchemy-state-store` Worker and its `Store` Durable
Object in the personal Cloudflare account, at `https://alchemy-state-store.<subdomain>.workers.dev`.
The Worker encrypts each record with a key it keeps in the account's Secrets Store.
`infra/state.ts` opens it for the hosted stack. The local stack keeps its state in the checkout,
because its resources are that machine's own Docker containers and processes.

A run reads two settings from its environment, like the Railway token:

- `ALCHEMY_STATE_URL`: the store's address.
- `ALCHEMY_STATE_TOKEN`: its bearer token. It is a secret: never type it into a command line or
  print it.

On the machine that deployed the store, Alchemy wrote both to
`~/.alchemy/credentials/<profile>/cloudflare-state-store.json`. A second machine is given them the
same way as `RAILWAY_API_TOKEN` (over `ssh` standard input into a file only its user can read, and
removed after the run). With these two, `RAILWAY_API_TOKEN`, `GITHUB_TOKEN` and `.env.production`,
any machine plans and deploys against the same state. It needs no Cloudflare login. A run that
cannot reach the store, or finds nothing for `vivid-production/production`, stops before it plans.

The store has no lock. Two runs at once can still overwrite each other's records, so one session
deploys at a time, as [Before a production deploy](#before-a-production-deploy) says.

After an Alchemy upgrade, run `alchemy provider cloudflare bootstrap --profile <profile>` once
before the next plan. `Cloudflare.state()` upgrades the Worker by itself, but `infra/state.ts`
talks to it directly and does not. The bootstrap needs a Cloudflare login for the personal account:
refresh the Alchemy profile (`alchemy profile refresh --profile <profile> --provider Cloudflare`),
or give it `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The state was copied in from the old deploy checkout's `.alchemy/` with `infra/copy/main.ts`, run
from an extracted backup of it. That directory is now a stale copy that nothing reads. The copy
refuses to overwrite state the store already holds differently, so a second run cannot roll a
later deploy back. Dated backups of the old state are kept beside the worktrees as
`alchemy-before-*.tgz`; they hold the settings' values, so they are secrets too.

### Before a production deploy

On 5 October 2026 two sessions ran `pnpm infra:deploy` from the same checkout one minute apart
(09:13 and 09:14 UTC), neither knowing of the other, and then both tried redeploys and rollbacks on
the Executor at once. Its old container hung in `stopping` and held the data volume, and the
Executor answered `502` for 55 minutes. No data was lost. The rules that came out of it:

- **One session deploys production.** It is the integrator named for the repository at the time.
  Every other session pushes a branch and opens a pull request; it does not run the deploy, a
  redeploy, a rollback or a Railway mutation, even to ship its own fix quickly, and even when
  production is down. If you find production broken, tell the Person and the integrator what
  you see; do not start a second repair beside theirs.
- A deploy sends everything on `main`, not only the change you came to ship. Read the plan the
  command prints (`Plan: …` and the `[Resource] update | replace | create` lines). If it touches
  a resource your change does not, find whose change that is (`git log -- infra/railway.ts`)
  before going on.
- Every checkout reads the same state from the hosted store, so a deploy can run from any clean
  checkout of current `main`. The store does not lock: the one-deployer rule above is what keeps
  two runs apart.
- The Railway CLI's session token lasts about an hour, and a deploy that outlives it fails with
  `RailwayForbidden … Not Authorized` part-way. Refresh it first (`railway whoami` with the
  personal profile) and check `user.tokenExpiresAt` in that profile's `config.json`.

### When a service with a volume will not start

Railway attaches a volume to one container at a time, so a deploy of a cell node, Executor,
PostgreSQL, or the retained historical Helix service stops the old container before the new one
starts (`infra/cells.ts`, `railwayCells`; `infra/railway.ts`, `railwayResources`). If the old container hangs in
`stopping`, it keeps the volume and every new deployment waits at `CREATE_CONTAINER` with no log
line until Railway fails it (about seventeen minutes), then tries again. The public address
answers `502` throughout. Redeploying or rolling back does not help: each attempt waits on the
same volume, and each new attempt cancels the one before it.

How to tell:

1. `railway ssh` into the service answers `Your service's container is not running (status:
stopping)`.
2. `railway deployment list --json`: the last deployment that worked still reads `SUCCESS` while
   newer ones sit in `DEPLOYING`. In the GraphQL API, `deploymentEvents` for a new one ends at
   `CREATE_CONTAINER` with no `completedAt`.

What to do, in this order, and only as the session that deploys:

1. Copy the volume's data off first if the service can still be reached, and keep the copy out
   of Git (it holds keys). The 5 October copy of the Executor's `/app/data` is under
   `artifacts/backup/`, which Git ignores.
2. Stop the old deployment by its id: GraphQL `mutation { deploymentStop(id: "<id>") }`.
3. If a new deployment still waits at `CREATE_CONTAINER`, move the volume to another service and
   back (`volumeInstanceUpdate`).
4. Deploy with `serviceInstanceDeployV2`. `serviceInstanceRedeploy` reuses the image of the last
   deployment, which after a rollback is the old one.

On 5 October steps 2 and 3 were both done within a minute of each other, by two sessions, so
which one released the container is not known; that is why both are listed. Between the two
volume moves the Executor ran for about three minutes with no volume, so with an empty store: it
passed `/health` and refused the server's key (`Invalid API key`). Health alone is therefore not
proof of recovery. Make one real call with the server's key (`GET
/api/organizations/<organization>/inventory`) and compare the answer with what it was: after the
recovery it was `200` and 8,914 bytes, the same as before.

Ruled out, so do not spend time on them again: the image (it pulled without credentials, and the
previous image hung the same way), the volume's own state (`READY`), the domain, the target port
and the region.

### Executor's image

The Executor service configuration pins the published image
`ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.23`, upstream tag
`executor@2.0.0-beta.23` at commit `26d03a48953c948c794c5cd9d22eb3f6253c1482`.
No fork build is needed. This configuration change does not deploy the service.

Beta.23 replaces profiles with app and user account links. Vivid allocates one app per new
Connection. Migrated references distinguish dedicated allocations, proven copies (with original
app provenance), and unproven shared-original access. Every active app selection is unique;
selection grants no deletion authority. A
shared original is never deleted; copy reclamation checks provenance and other stored holders.
A scoped background worker reconciles legacy rows using copy provenance and exact account links.
Boot, `/health`, Integration reads and tool discovery never wait for this pass. Each pass probes
`/inventory` once before touching rows. An old, malformed or unreachable inventory leaves every
row untouched; the decoder presents legacy rows as `MigrationPending`. After a compatible probe,
per-row transient failures retry with backoff from five seconds to one minute. Identical JSON is
not rewritten; counter-only bookkeeping preserves `updatedAt`, so it cannot invalidate a concurrent
removal. Meaningful outcome changes advance that revision. A missing, undeployed or unreachable
per-row target has a persisted budget of
1,440 compatible unsuccessful attempts, roughly 24 hours at the worker's one-minute backoff cap.
Only compatible attempts advance that counter; an outage after migration has started consumes
none of it, and recovery cannot expire rows merely because wall-clock time passed. Permanent refusals retain the exact credential and copy identities for removal.
Executor migrates its own storage from 4.0.5 through 4.0.15; the old image cannot open that volume.

**Production cutover.** The supported order is server first, then image. Merging updates the server
through Railway's repository trigger; infrastructure deployment requires clean current `main`.
The new server against `src-304bf60` boots and serves health, but Integrations are unavailable and
legacy rows remain pending without writes. The old server against beta.23 breaks Integration
routes because profiles were removed. Neither mixed pairing can perform Integration work.

1. Announce a maintenance window and let admitted Runs settle. Avoid Integration work during the mixed-version interval.
   Use Railway's [deployment Remove action](https://docs.railway.com/deployments/deployment-actions#remove)
   to stop Server and Runtime, then Executor, for the paired backups. Do not accept product writes
   while taking the backups. These stops are temporary; the merge can deploy Server again.
2. Create Railway **volume backups** of both the entire Executor volume (including encrypted
   keys) and the Vivid PostgreSQL volume (the complete volume, including any historical runtime rows). The GraphQL create
   mutation is `volumeInstanceBackupCreate(volumeInstanceId, name)`; give the two backups one
   cutover name and record both backup IDs, volume-instance IDs, server SHA, old image digest
   and configuration. Wait for both backups to finish before continuing. Use each service's
   Backups tab to verify the pair completed. Before the window, rehearse
   `volumeInstanceBackupRestore(volumeInstanceId, volumeInstanceBackupId)` on a disposable backup
   pair in its own environment; verify PostgreSQL recovery and the old image's access to its
   restored encrypted store. Railway restores within the original environment; this rehearsal
   proves the procedure, not the production backups. Never rehearse against production volumes.
   Railway's [GraphQL schema](https://github.com/railwayapp/cli/blob/master/src/gql/schema.json),
   [API cookbook](https://docs.railway.com/integrations/api/api-cookbook#volumes) and
   [backup restore procedure](https://docs.railway.com/volumes/backups) describe these operations.
3. Merge the reviewed upgrade to `main`. Railway deploys the new server against the **old**
   Executor image. Always use Railway's Redeploy action on the recorded old Executor deployment
   to restart `src-304bf60`; the merge does not restart this image-backed service. Confirm the
   new server's `/health` succeeds. Its log should show `Integration migration waiting for compatible inventory` with
   a failure tag. Legacy selections must stay pending; do not ask Persons to reconnect during
   this interval. Avoid Integration actions until verification.
4. Use a clean checkout of current `main`, with the settings
   [Running the stack's own deploy](#running-the-stacks-own-deploy) lists. Then run `pnpm infra:deploy --yes` (the authorized
   `alchemy deploy --stage production --env-file .env.production` entry point). This changes the
   Executor image to `ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.23`. Wait for its health
   check and storage migration. The server keeps retrying in its own scope; the next pass starts
   within one minute after the current attempt finishes. No screen read is needed to trigger it.
   Verify **both Server and Runtime** have active deployments from the merged main revision and
   passing health checks. Do not assume Alchemy recreated deployments removed for backup. If one
   is still removed, use Railway's Redeploy action for the recorded main deployment, then verify
   its revision and health again. Runtime deliberately returns before step-5 verification;
   Integration readiness and tool selection fail closed while legacy rows remain pending.
   Verify Run outcomes after both services return; admission cannot finish while Runtime is Removed.
5. Check `Integration app reconciliation` log entries: each has `connectionId` and `result`
   (`Authorized`, `Public`, a pending authorization variant, `MigrationPending`, or
   `ReconnectRequired`). Check the read-only SQL below. Pending rows mean the upstream copy
   plan or deployment has not finished; inspect exact `copiedFrom.reference`, account links and
   active versions rather than assuming `/health` alone proves every copy ready. Confirm two
   Persons keep distinct account/app identities, perform a safe authenticated read for each,
   and add/remove a disposable keyed/public Connection. Verify removal preserves the other
   Person's access. Check Run outcomes from the window. Resume
   ordinary use only after these checks pass.

```sql
-- Raw legacy JSON is projected as pending until its first successful compatible-protocol pass.
SELECT CASE WHEN "references" ? 'profile' THEN 'LegacyPending'
            ELSE "references"->>'_tag' END AS outcome,
       "references"->>'reason' AS reason, count(*)
FROM vivid_connections GROUP BY 1, 2 ORDER BY 1, 2;

-- Must return zero rows: every active selection agrees with its unique app column.
SELECT id, executor_app, "references"->>'_tag' AS outcome
FROM vivid_connections
WHERE executor_app IS DISTINCT FROM
  CASE WHEN NOT ("references" ? 'profile')
         AND "references"->>'_tag' NOT IN ('MigrationPending', 'ReconnectRequired')
       THEN "references"->>'app' ELSE NULL END;
```

Allow 10–15 minutes for backups, build, image startup and verification; this is an operational
allowance, not a measured production duration. Backup stops briefly affect all Vivid requests.
Integrations are unavailable from the server cutover until the image is healthy and the worker
finishes reconciling each selection. Provider outages or large copy plans extend that interval;
server health stays independent. Rows with permanent ambiguity require the Person to reconnect.

**Rollback.** Quiesce writes and remove the Server, Runtime and Executor deployments again.
Do not push the server revert yet. Stage **both** recorded volume restorations with
`volumeInstanceBackupRestore(volumeInstanceId, volumeInstanceBackupId)`. Before applying the
Executor volume replacement, set its staged service image to the recorded old tag
`ghcr.io/konan69/executor-selfhost:src-304bf60`; review the image and volume together in Railway's
Details panel. Never restart beta.23 against the restored old store, since it would migrate it
again. Apply the PostgreSQL and Executor restorations while Server and Runtime remain stopped;
the previous volumes remain unmounted. Verify the old image opens its restored store.

Only after both stores are restored, publish the reviewed revert of the server upgrade and
infrastructure image pin to `main`. The old server's automatic deploy now sees the old protocol
and original Connection JSON. The emergency image selection and the reverted Alchemy declaration
must agree before any subsequent clean-main `infra:deploy`. Keep Runtime stopped until both
services and the original Connection/profile behavior are verified, then resume Runtime. A server-only, image-only or single-volume rollback is invalid. The old image
cannot open the migrated volume; the old server cannot decode reconciled JSON. Writes since the
backup pair are lost on restoration and must be accounted for before reopening service.

A narrow duplicate-selection race remains during removal: two legacy Connections can reference
one account, and a retirement clears its app claim before taking the reclamation lock. A migration
pass starting in that gap can select the same copy before retirement deletes it. The resulting
Connection has missing resources; its removal tolerates missing apps/accounts and finishes cleanup.
This limitation does not permit selecting a different account. Avoid concurrent removal/reconciliation
of duplicate legacy selections during cutover; inspect both rows if this occurs.

### Executor's trace exporter is off

`infra/railway.ts` supplies only `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, without a trace or base
endpoint. Beta.23's `apps/hosted/self-host/src/worker.ts:136-146` then skips the bundled telemetry
fallback, and `packages/telemetry/src/layer.ts:40-60` installs no trace exporter. Idle scheduler
spans still exist in upstream code.

The setting does not stop the bundled collector. Beta.23's `apps/hosted/self-host/native/main.go:709-719`
starts Motel as a separate supervised process on a private Unix socket. The configured TCP logs
address does not reach it; console logs remain while OTLP log exports fail and retry. A real
external logs destination can replace that address while retaining logs-only trace suppression.

### Telemetry volume

The server exports spans and log lines to Sentry over OTLP. Export is by allowlist, and work that
repeats with nobody asking is not traced at all: timer passes (approvals, push,
presence), live query reloads and session watchers run under `untraced`
(`apps/server/src/observability/quiet.ts`), and functions called once per item of a large list
are `Effect.fnUntraced`. Before those rules, one Person produced 119,000 spans an hour: 95,000
from three spans per Integration catalogue entry on every catalogue read, the rest from timers
and reloads. After a deploy, check the rate in Sentry (spans grouped by `span.name`, last hour);
a name with thousands of spans and no request behind it is a loop being traced.

## Run locally

1. Install dependencies with `pnpm install` using Node 24 or newer and pnpm `12.4.2`.
2. Start Docker.
3. Supply the application credentials below in the process environment.
4. Run `pnpm infra:verify`.
5. Run `pnpm infra:dev`.

The stack binds its processes to loopback. Remote browser or phone access needs a reachable
proxy or port forwarding. Alchemy supplies process environments; copying the root `.env.example`
is not enough because `infra/env.ts` does not load it. Its old Google redirect points at a retired
Integration route; Google account sign-in uses `/api/auth/callback/google`.

The stack currently supplies `PUBLIC_URL` as the server origin on `8787`, while people open the
web proxy on `5178`. Better Auth trusts only its configured public origin. That mismatch remains
an owner decision; this document does not claim the default proxy sign-in setup is verified.

`pnpm infra:destroy` selects only the local target and tears down Alchemy/Docker resources,
including the database volume. It is not a test cleanup command: the real local database,
Alchemy state, and runtime state are read/copy only for audits and tests. Tests require a
disposable database through `VIVID_TEST_DATABASE_URL`. Startup applies committed migrations;
Drizzle generation is a separate developer action.

### Credentials and external services

Required by the stack:

- `AUTH_SECRET` — the server requires at least 32 characters, 12 distinct characters, and 3 character classes.
- `OPENCODE_API_KEY` — OpenCode Go, which Vivid's replies come through.
- `OPENROUTER_API_KEY` for server title and decision calls.
- `VIVID_RUNTIME_TOKEN` — authority shared only between the application server and runtime host.
- `VIVID_BOAT_API_KEY` — the Boat key Vivid's Computer is reached with. A secret.
- `VIVID_BOAT_TEMPLATE` — the name of the prepared Boat template a Person's Computer is restored
  from (`infra/computer/prepare.py` prints it).
- No SSH key is a setting. The server makes a key pair for each connection to a Computer and
  has Boat authorize it on that one machine (`docs/04-computer.md`, "Reaching the Computer").
- `VIVID_PHOTON_PROJECT_ID`, `VIVID_PHOTON_PROJECT_SECRET` — the Photon project Vivid texts
  through. The secret is a secret.
- `VIVID_PUSH_VAPID_PUBLIC`, `VIVID_PUSH_VAPID_PRIVATE`, `VIVID_PUSH_SUBJECT` — the key pair and
  contact (`https:` or `mailto:`) that notifications while away are signed with. Generate the pair
  once for an environment and keep it; a new pair unsubscribes every browser and phone:

  ```sh
  node -e "const c=require('node:crypto').createECDH('prime256v1');c.generateKeys();console.log('VIVID_PUSH_VAPID_PUBLIC='+c.getPublicKey().toString('base64url'));console.log('VIVID_PUSH_VAPID_PRIVATE='+c.getPrivateKey().toString('base64url'))"
  ```

- `VIVID_EXECUTOR_KEY`, `VIVID_EXECUTOR_ORGANIZATION` — the key and organization the server uses
  on Executor, which gives Vivid its Integrations. Both are minted on the deployed Executor.
- `VIVID_EXECUTOR_OWNER_EMAIL`, `VIVID_EXECUTOR_OWNER_PASSWORD` — the Executor owner's sign-in. The
  server invites each Person's own Executor member with it the first time that Person connects an
  Integration of their own (`apps/server/src/connections/members.ts`).
- `VIVID_EXECUTOR_SEAL_KEY` — 32 random bytes in base64 (`openssl rand -base64 32`). It seals each
  member's key in PostgreSQL and derives each member's password, so it is set once per
  installation and never replaced: a new value strands every member.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — the Google client a Person
  signs in through. The same client signs a Person in to a Google Integration, so it must also
  allow `https://<server domain>/api/connections/return` (`docs/22-one-product.md`, "Google
  Integrations").

Every part of the product is required, here and in the server. The stack stops before it touches
the target and names the variable it lacks, and the server does not start without the same
settings (`requiredSetting` in `apps/server/src/config.ts`), so neither a deploy nor a running
server can be missing the Computer, memory, Integrations, texting, away notifications or Google
sign-in. `pnpm infra:verify` fails when a setting the server requires is not sent by this stack.
`VIVID_BOAT_ORG`, `VIVID_BOAT_SIZE`, `VIVID_BOAT_LIFETIME_SECONDS` and `VIVID_BOAT_MACHINE` are
forwarded to the hosted server when set (`apps/server/src/computers/README.md` says what each
does).

Cell memory opens beside Pi's tables without a filesystem directory binding
(`apps/cells/src/main.ts`, `Person`). `cellVariables` in `infra/cells.ts` supplies private model
credentials, server-call authority, and optional `VIVID_DECISIONS`. The cell's learning gate
uses Jev when enabled and an OpenRouter key is present; decisions default off
(`packages/agent/runtime/src/settings.ts`, `decisionLayer`). `VIVID_MODEL` defaults to
`opencode-go/glm-5.3-flash` (`packages/agent/runtime/src/providers/models.ts`, `makeProviders`;
`packages/agent/runtime/src/providers/opencode.ts`, `DEFAULT_MODEL`).

History. The hosted stack retains the old Helix service and volume, and the disconnected
`RuntimeMemory` volume, for migration (`infra/railway.ts`, `railwayResources`). Current personal
memory lives only in the Person cell (`apps/cells/src/main.ts`, `Person`).

The hosted stack runs Executor and gives the server its private address
(`VIVID_EXECUTOR_URL`), and gives the server the settings above. Boat and Photon are outside
services the stack does not provision. The local process graph runs none of these services and
has no stand-in for them: `Command.Dev` merges the stack's variables over the environment
`pnpm infra:dev` was started in, so a local server reads `VIVID_EXECUTOR_URL`
and the rest from that environment, and does not start without them.

Outputs contain only web, server, and runtime URLs. Database and application secrets are never
outputs. Local Alchemy resources create no AWS bill, but real model calls and external services
may cost money; their charges are separate from local CPU and storage.

## Containers

Build the server image from the repository root:

```sh
docker build -f apps/server/Dockerfile -t vivid-server .
```

The server image uses Node 24 and the root manifest's pinned pnpm through Corepack, preserves
the installed workspace layout, and runs `pnpm --filter @vivid/server start` as the non-root
`node` user. The image also includes celld and the cells workspace for Worker publication
(`apps/server/Dockerfile`). `apps/cells/scripts/build.mjs` (`main`) owns native Worker bundling
and publication.
No credential or application origin is supplied at build time. Container health checks use
`GET /health` on the configured `PORT`.

The server image defaults to `HOST=0.0.0.0`, `PORT=8787`, and
`VIVID_WEB_DIST=/app/apps/web/dist`. It builds and serves the web app on the server's origin:
API routes, WebSocket upgrades, and health retain priority; other GET/HEAD requests serve files
or the SPA document. Content-hashed assets cache immutably; the document revalidates. Traversal
and symlinks outside the static root are refused. Without `VIVID_WEB_DIST`, local startup serves
no static app; without `HOST`, it retains `127.0.0.1`.

The same image carries the mobile app's JavaScript as an over-the-air update
(`VIVID_MOBILE_UPDATES=/app/apps/mobile/updates`, exported by `apps/mobile/scripts/publish.mjs`
in the image's `updates` stage). The server answers the installed app's update check at
`/api/updates/manifest` and serves the files at `/api/updates/assets`, speaking the Expo Updates
protocol itself; no Expo service is involved. A deploy is therefore also the publish: an installed
app with the same runtime version (`version` in `apps/mobile/app.json`) downloads the new
JavaScript at its next launch. A change to native code needs a new `version` and a new binary.
Without `VIVID_MOBILE_UPDATES` the routes do not exist.

The server exports traces and logs over OpenTelemetry when `VIVID_OTLP_URL` and
`VIVID_OTLP_HEADERS` are both set, and exports nothing when neither is; one without the other
stops the launch. `VIVID_OTLP_URL` is the OTLP/HTTP base address (the server appends `/v1/traces`
and `/v1/logs`; metrics are not exported), and `VIVID_OTLP_HEADERS` is the backend's credential as
comma-separated `name=value` pairs, held as a secret. Every failure that reaches a boundary is
exported with `error.type` (the error's tag), `vivid.failure.kind` (`expected` or `defect`) and
`vivid.boundary` (`rpc`, `http`, `schedule` or `runtime`); every refusal is a `vivid.refusal`
event with `vivid.refusal.kind`. Only attributes on an allowlist leave the process, never message
text, and stdout logging is unchanged. An export gets one attempt. When one fails (a reset, a
`503`, a timeout), that signal is not exported for the next 60 seconds: what it recorded just
before the failure and during that minute never reaches the backend and is not sent later. This
is accepted, because the product must not depend on the backend. The server's stdout log on the
host keeps every line, and each gap is marked there by a `Telemetry batches dropped` line that
names the signal (`vivid.export.signal`) and the pause (`vivid.export.paused_seconds=60`). The
resource is `vivid-server`, with `VIVID_ENVIRONMENT` and `VIVID_BUILD_COMMIT` when they
are set, and an empty value counts as unset. On Railway the environment is filled from
`RAILWAY_ENVIRONMENT_NAME` at run time, and the commit is written into the server image by its
build from `RAILWAY_GIT_COMMIT_SHA` (`apps/server/Dockerfile`); the run-time `VIVID_COMMIT` that
`infra/railway.ts` still sets resolves empty and is no longer read. The code is
`apps/server/src/observability/`.

Supply the server with `DATABASE_URL`, `AUTH_SECRET`, `VIVID_RUNTIME_URL`,
`VIVID_RUNTIME_TOKEN`, and the externally reachable `PUBLIC_URL`. The runtime host needs the
server-call authority and model credentials through private Worker bindings. It has no product
PostgreSQL URL or memory directory requirement (`packages/agent/runtime/src/settings.ts`,
`settingsLayer`; `infra/cells.ts`, `cellVariables`). Alchemy declares its endpoints and fleet
storage (`infra/cells.ts`, `railwayCells`).
The server also needs the capabilities listed under "Credentials and external services".
Apply auth then product migrations before starting the server. Pi uses its native SQLite
storage inside the cell.

Programs (`run_code`) need nothing from the server's host. A program runs on the Person's
Computer: the server starts its runner there over its SSH connection to the Computer, reads what
it prints, and answers its calls on the same channel. Until 5 October 2026 a program ran on the server's own host inside
user-systemd, a cgroup and bubblewrap, which an ordinary container does not have, so production
refused every program. The server image therefore carries no isolation tools, and the only
requirement is the one every Vivid already has: a Computer provider.

These recipes provide packaging, not deployment resources. Alchemy remains the resource owner;
building an image neither calls Railway nor changes the local development graph.

Railway uploads the repository root through Alchemy's filtered context packer, selecting each
checked-in Dockerfile. It does not bundle an application through `main` or `extraFiles`.
Both Services pin `startCommand` to the image's `CMD`; the offline verifier rejects drift.
The old standalone runtime service and volume are replaced by the chosen cell fleet. Keep
server startup, product migrations, and health independent from runtime availability. Cell
packaging, private routing, and deployment verification remain part of the infrastructure
integration in progress. No PG-runtime deployment is a prerequisite for that work.

## Outside the current stack

- **Computer:** the server provisions through Boat's API or an explicit local Docker adapter;
  Alchemy does not declare a Computer resource.
- **Executor:** externally configured; it is not an Alchemy resource today. Railway provisions
  Executor separately from the local graph.
- **Desktop:** distributed client software, not a cloud resource.
- **Artifact object storage:** Library bytes and Markdown Artifact versions stay in PostgreSQL.

## Historical beta.76 provider evaluation

The following is the earlier AWS candidate evaluation, not the current resource graph. Its
versioned inventory and deployment candidates are retained as research; recheck installed
source before using them.

## Why these resources

| Need now        | Declared resource                                         | Local implementation in beta.76                  | Decision                                                                                      |
| --------------- | --------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| PostgreSQL      | `Docker.RemoteImage`, `Docker.Volume`, `Docker.Container` | Native Docker provider                           | Use now; required PostgreSQL 18 and persistent local volume.                                  |
| Server/runtime  | `Command.Dev`                                             | Alchemy dev sidecar                              | Use now; stable localhost URLs are required by callbacks and proxies. ECS is deferred.        |
| SPA             | `AWS.Website.StaticSite`                                  | Website dev-server provider                      | Use now; in dev it runs Vite and does not create S3/CloudFront.                               |
| Migrations      | `Command.Exec`                                            | Local command provider                           | Use now; one finite command enforces the required order.                                      |
| Hosted compute  | ECS                                                       | Specialized Floci providers for Task and Service | Defer until remote deployment is enabled.                                                     |
| Object storage  | S3                                                        | Floci dual provider exists                       | Do not declare; product files and artifacts remain in Postgres.                               |
| Managed secrets | Secrets Manager/SSM                                       | Floci dual providers exist                       | Do not declare; Effect Config is the current source and duplicate secret stores add no value. |
| App Runner      | App Runner Service                                        | No dual/local registration found                 | Do not use for this local-first stack.                                                        |

The AWS Website Vite construct was considered, but beta.76 needs the optional `@alchemy.run/frontend-frameworks` package. `StaticSite` already has the required Vite dev-command behavior, so adding that dependency would provide no current value.

## What `alchemy dev` does

AWS providers in installed `alchemy@2.0.0-beta.76` select local implementations during `alchemy dev`. Floci is a persistent local AWS emulator; specialized Lambda/ECS providers can build images, watch sources, and reconcile local workloads. The website and command providers keep long-running dev processes in Alchemy's sidecar so user-code reloads do not kill them.

Provider mode is stored with each resource. Changing a resource between local and live mode is a **replacement**, not an in-place update. Registering the same resource under conflicting mode policies fails.

`Alchemy.remote()` opts a resource or Effect scope out of emulation: during `alchemy dev` it selects the live provider and can call real AWS APIs. During `alchemy deploy` everything is already live, so it changes nothing. `remote(false)` returns to the run default. This stack intentionally does not call `Alchemy.remote()`; therefore local development cannot cross into AWS.

## Exact beta.76 AWS local-provider inventory

This list is derived from `alchemy/src/AWS/Providers.ts`. The following 223 resources are registered through `flociDual(...)` or an explicit dual provider. ECS Service/Task and Lambda Function/MicrovmImage use specialized local providers rather than the generic Floci wrapper.

- **ACM:** AccountConfiguration, Certificate
- **ApiGateway:** Account, ApiKey, Authorizer, BasePathMapping, DeploymentResource, DomainName, GatewayResource, GatewayResponse, MethodResource, RestApi, StageResource, UsagePlan, UsagePlanKey, VpcLink
- **ApiGatewayV2:** Api, AuthorizerResource, DomainName, IntegrationResource, RouteResource, StageResource, VpcLink
- **AppConfig:** Application, ConfigurationProfile, Deployment, DeploymentStrategy, Environment, Extension, ExtensionAssociation, HostedConfigurationVersion
- **AppSync:** ApiAssociationResource, ApiKeyResource, DataSourceResource, DomainName, FunctionResource, GraphqlApi, ResolverResource
- **ApplicationAutoScaling:** ScalableTarget, ScalingPolicy, ScheduledAction
- **Athena:** DataCatalog, NamedQuery, PreparedStatement, WorkGroup
- **AutoScaling:** AutoScalingGroup, LaunchTemplate, LifecycleHook, ScalingPolicy, ScheduledAction
- **Batch:** ComputeEnvironment, JobDefinition, JobQueue
- **CloudFront:** CachePolicy, Distribution, Function, Invalidation, KeyGroup, KeyValueStore, KvEntries, KvRoutesUpdate, OriginAccessControl, OriginRequestPolicy, PublicKey, RealtimeLogConfig, ResponseHeadersPolicy, VpcOrigin
- **CloudMap:** HttpNamespace, InstanceRegistration, PrivateDnsNamespace, PublicDnsNamespace, Service
- **Cognito:** Group, IdentityPool, IdentityPoolRoleAttachment, IdentityProvider, ManagedLoginBranding, ResourceServer, User, UserPool, UserPoolClient, UserPoolDomain
- **DynamoDB:** Table
- **EC2:** DhcpOptions, EIP, EgressOnlyInternetGateway, FlowLog, Instance, InternetGateway, KeyPair, NatGateway, NetworkAcl, NetworkAclAssociation, NetworkAclEntry, NetworkInterface, NetworkInterfaceAttachment, PrefixList, Route, RouteTable, RouteTableAssociation, SecurityGroup, SecurityGroupRule, Snapshot, Subnet, Volume, VolumeAttachment, Vpc, VpcEndpoint, VpcPeeringConnection
- **ECR:** Image, RegistryPolicy, Repository
- **ECS:** CapacityProvider, Cluster, Service, Task, TaskDefinition
- **ELBv2:** Listener, ListenerCertificate, ListenerRule, LoadBalancer, TargetGroup, TargetGroupAttachment, TrustStore
- **EventBridge:** ApiDestination, Archive, Connection, EventBus, Permission, Rule
- **Firehose:** DeliveryStream
- **Glue:** Connection, Crawler, Database, Job, Table
- **IAM:** AccessKey, AccountAlias, AccountPasswordPolicy, Group, GroupMembership, InstanceProfile, LoginProfile, OpenIDConnectProvider, Policy, Role, SAMLProvider, SSHPublicKey, ServerCertificate, ServiceLinkedRole, ServiceSpecificCredential, SigningCertificate, User, VirtualMFADevice
- **KMS:** Alias, Key
- **Kinesis:** Stream, StreamConsumer
- **Lambda:** Alias, EventSourceMapping, Function, LayerVersion, MicrovmImage, NetworkConnector, Permission, Version
- **Logs:** Destination, LogGroup, LogStream, MetricFilter, ResourcePolicy, SubscriptionFilter
- **Pipes:** Pipe
- **RDS:** DBCluster, DBClusterEndpoint, DBClusterParameterGroup, DBInstance, DBParameterGroup, DBSubnetGroup
- **Route53:** HealthCheck, HostedZone, QueryLoggingConfig, Record, Records, VpcAssociationAuthorization, ZoneVpcAssociation
- **S3:** Bucket
- **S3Vectors:** Index, VectorBucket
- **SES:** AccountSettings, ActiveReceiptRuleSet, ConfigurationSet, ConfigurationSetEventDestination, Contact, ContactList, CustomVerificationEmailTemplate, DedicatedIpPool, EmailIdentity, EmailIdentityPolicy, EmailTemplate, MultiRegionEndpoint, ReceiptFilter, ReceiptRule, ReceiptRuleSet, Tenant, TenantResourceAssociation
- **SNS:** Subscription, Topic
- **SQS:** Queue
- **SSM:** Parameter
- **Scheduler:** Schedule, ScheduleGroup
- **SecretsManager:** RotationSchedule, Secret
- **StepFunctions:** Activity, StateMachine
- **WAFv2:** IPSet, LoggingConfiguration, RegexPatternSet, RuleGroup, WebACL, WebACLAssociation
- **Website:** AssetDeployment

`AWS.Website.Server` also has a separate local/live provider pair. `Command.Dev` and `Command.Exec` are generic Alchemy local providers, and Docker resources are mode-agnostic rather than AWS emulations.

This is API-shape evidence, not a claim of perfect AWS behavioral parity. beta.76 is pre-release software: emulator behavior, optional packages, and declaration shapes must be rechecked before enabling remote targets or upgrading Alchemy.

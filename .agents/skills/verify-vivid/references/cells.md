# Prove native cell recovery

Run these checks only on the selected devbox at the combined head. The source integration has
not passed these journeys yet. A control receipt records an operation, not product recovery.

## Package the Worker

`pnpm --filter @vivid/cells build` calls celld 0.6.2's native `deploy --dry-run --json` against
`apps/cells/wrangler.jsonc`. It retains `apps/cells/dist/deployment.json`, a build receipt.
celld exposes no reusable bundle export through this CLI. A dry run does not activate an isolate.

Deployment uses this invocation from the repository root.

```sh
node apps/cells/scripts/build.mjs deploy /private/project/wrangler.json /private/receipt.json --bucket s3://BUCKET --endpoint ENDPOINT --region REGION
```

The private project's `src` directory links to the shipped `apps/cells/src`. Its config keeps
`main: src/main.ts`, the `vivid-cells` script name, the `Person` class, migrations and Text rules.
celld rejects absolute or parent-relative main paths. The launcher inserts a private `vars`
object into the source JSONC and lets celld parse and validate it. The vars contain
`VIVID_RUNTIME_TOKEN`, `VIVID_SERVER_URL`, `VIVID_MODEL` and explicit provider keys. Deploy does
not turn process environment or `.dev.vars` into Worker bindings. Keep this config out of
evidence and delete it during Cleanup. The wrapper resolves esbuild from the cells package.

celld publishes native modules and a manifest under `deploy/vivid-cells/<version>` and advances
its deployment pointers. The retained receipt contains worker, version, location and dry_run.
Two native nodes load that deployment from this run's private MinIO bucket. Their local SQLite,
LTX and bucket credentials live only inside owned scratch. No runtime PostgreSQL migration runs.

## Inspect and control the owned nodes

Use the explicit run id printed by Launch. `runtime` is the server's gateway node;
`runtime-peer` is its successor. Operator ports stay on loopback and require captured PID
ownership. Each operation retains its own `cell-<uuid>/` evidence.

```sh
.agents/skills/verify-vivid/verify cell state runtime pi-<id>
.agents/skills/verify-vivid/verify cell list runtime pi-<id>
.agents/skills/verify-vivid/verify cell restart runtime pi-<id>
.agents/skills/verify-vivid/verify cell move runtime pi-<id>
.agents/skills/verify-vivid/verify cell owner-loss runtime pi-<id>
.agents/skills/verify-vivid/verify cell stop runtime-peer pi-<id>
.agents/skills/verify-vivid/verify cell start runtime-peer pi-<id>
.agents/skills/verify-vivid/verify cell evict runtime Person:<scope-id-from-list> pi-<id>
```

Restart uses `/shutdown?handoff=preserve`. Move uses normal `/shutdown`, then restarts the node.
Owner-loss kills only its captured generation and leaves it down. After the survivor proof,
restart it explicitly with `verify cell start`. Both nodes keep their original
native storage paths and run-scoped `CELLD_NODE` identities, matching celld's same-node reload
pattern. They share the same disposable bucket. Before/after `/state` receipts retain
native deployment and ownership counters. A node restart alone does not prove that a particular
Person changed owner. Compare that Person's owner in the actual native receipts. Eviction uses
celld's `/evict/<scope>` and can refuse active work. Such a refusal is a failure, not a proof.

## Drive the recovery claims

1. Run Launch, Doctor, HTTP first and notes, then their browser recipes with the real model.
   Keep the initial model, terminal settlement, history and tool receipts.
2. Keep a real WatchConversation subscription open. Run move on its owner. Require a native
   owner change and automatic reconnect with the same history and no duplicate Run or reply.
3. For wake, evict the idle Person using its listed native scope. Send another ordinary message
   through the product. Separately interrupt an active response with owner-loss and require
   Pi's persisted alarm to finish that same submission without a new admission. Retain the alarm,
   ownership, native terminal wait and real settled Run evidence. No sleep establishes a wake.
4. Run HTTP stop and browser stop. Require the captured active Run to settle Stopped and the
   interrupted text to survive reload. Run picture and its browser recipe for retained bytes.
5. Run restart and repeat Notes recall through the product. Compare native receipts and history.
   Local retraction never proves full forgetting. Repeat Doctor and Cleanup.

Missing credentials, an incompatible binary, failed image pulls, failed native activation,
missing browser recipes or absent owner/alarm receipts block the associated claim. Rehearsal
proves plumbing only. Phone and desktop need their own real clients. Cleanup must remove both
captured nodes, bucket containers and anonymous volumes, private config, credentials and SQLite,
while preserving evidence. Crash cleanup uses the same recorded ownership.

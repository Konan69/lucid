# Executor integration proofs

The adapter uses `ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.23`, upstream tag
`executor@2.0.0-beta.23`. Use the published image directly; no fork checkout or image build is needed.

Each new Connection allocates a dedicated Executor app. Its reference records the requirement and scope,
plus the saved account or pending authorization. A scoped background worker starts at server boot;
reads and health never invoke or await it. Each idempotent pass probes inventory once before any
write. An old-shape or unreachable inventory leaves every legacy selection pending and untouched.
The pass maps `copiedFrom.reference` and exact requirement/account links, saving changed outcomes
under a cross-process claim lock. Permanent refusals retain exact credentials and copies for safe
removal. Transient failures, undeployed copies and unfinished copy plans retry with capped backoff;
per-row retries have a persisted budget of 1,440 compatible unsuccessful attempts (roughly
24 hours at the capped cadence). Global outages never consume that budget.
Global protocol failures cannot turn the mixed-version rollout into permanent refusals. Invalid
rows are logged and excluded from the retry count; no retryable rows ends the worker. The
`executor_app` selection is unique and checked against every active reference. Selection grants
no deletion authority: legacy selections on shared originals retain Unproven ownership, and
proven copies retain their original app identity for safe reclamation. Removal revokes only their exact
unretained credential and preserves the shared app and other links.

Executor's storage migration does not update Vivid's PostgreSQL rows. Back up both the entire
Executor volume with its keys and Vivid PostgreSQL. See the cutover and rollback sequence in
[Executor's image](../../../../docs/19-infrastructure.md#executors-image). Neither mixed server/image
pairing supports Integrations, and an old image cannot open the migrated store.

The opt-in `migration.live.test.ts` has a two-process proof. Run its seed section against an
archive of original Vivid and the old image. Copy only that section into the archive, omitting the
branch-only `migration.ts` import; the verifier stays in this checkout. Keep the seed process alive
on its release FIFO, start beta.23 on that same volume, migrate only its disposable PostgreSQL
worker database, then run verify mode. The receipt contains only fixture IDs and its disposable
database name. Before replacing the old image, run `VIVID_EXECUTOR_MIGRATION=waiting` against
that retained database after applying this branch's generated product migration. It proves the
new server leaves all three original selections and revisions intact on the old protocol. Then
switch the same volume to beta.23. Verify runs the explicit pass and checks both original account identities, separate
app IDs and a retained unfinished key card. It then removes the Connection on the shared original
and verifies that app and the other account still work before releasing seed.

For a fresh-image proof, run from the repository root:

```sh
set -eu
set +x
# Allow slow public TCP connections on hosts whose default family-attempt timeout is too short.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--network-family-autoselection-attempt-timeout=2000"
VIVID_SOURCE="$PWD"
EXECUTOR_IMAGE=ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.23
docker pull "$EXECUTOR_IMAGE"
# Disposable resources only; never reuse a production or development data volume.
EXECUTOR_VOLUME=
EXECUTOR_CONTAINER=
PG_CONTAINER=
cleanup() {
  if [ -n "$PG_CONTAINER" ]; then docker rm --force --volumes "$PG_CONTAINER" >/dev/null; fi
  if [ -n "$EXECUTOR_CONTAINER" ]; then docker rm --force "$EXECUTOR_CONTAINER" >/dev/null; fi
  if [ -n "$EXECUTOR_VOLUME" ]; then docker volume rm "$EXECUTOR_VOLUME" >/dev/null; fi
  unset VIVID_TEST_EXECUTOR_KEY VIVID_TEST_GITHUB_TOKEN
}
trap cleanup EXIT HUP INT TERM
EXECUTOR_VOLUME=$(docker volume create)
EXECUTOR_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EXECUTOR_CONTAINER=$(docker run --detach --init \
  --publish 127.0.0.1:44217:4400 \
  --env BETTER_AUTH_URL=http://127.0.0.1:44217 \
  --env EXECUTOR_OAUTH_CALLBACK_URL=https://vivid.example.test/api/connections/return \
  --env OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:9/ \
  --volume "$EXECUTOR_VOLUME:/app/data" \
  --env EXECUTOR_URL_ALLOW_LOOPBACK_HTTP=false \
  --env 'EXECUTOR_URL_ALLOW_HTTP_ORIGINS=[]' \
  --env EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=false \
  "$EXECUTOR_IMAGE")
export EXECUTOR_CONTAINER EXECUTOR_STARTED
VIVID_TEST_EXECUTOR_URL="http://$(docker port "$EXECUTOR_CONTAINER" 4400/tcp)"
export VIVID_TEST_EXECUTOR_URL

# Await Docker's health receipt; no sleeps or app-state polling.
wait_healthy() {
  python3 - "$1" "$2" <<'PYHEALTH'
import selectors, subprocess, sys, time
events = subprocess.Popen([
    "docker", "events", "--since", sys.argv[2],
    "--filter", "container=" + sys.argv[1],
    "--filter", "event=health_status", "--format", "{{.Status}}",
], stdout=subprocess.PIPE, text=True)
selector = selectors.DefaultSelector()
selector.register(events.stdout, selectors.EVENT_READ)
deadline = time.monotonic() + 180
try:
    while True:
        if not selector.select(max(0, deadline - time.monotonic())):
            raise SystemExit("Disposable container health timed out")
        event = events.stdout.readline().strip()
        if event == "health_status: healthy":
            break
        if event == "health_status: unhealthy" or not event:
            raise SystemExit("Disposable container did not become healthy")
finally:
    selector.close()
    events.terminate()
    events.wait()
PYHEALTH
}
wait_healthy "$EXECUTOR_CONTAINER" "$EXECUTOR_STARTED"

# Setup creates both the first admin and the instance's organization. Better Auth owns
# the session and API key. Keep cookies in memory; capture exports without printing secrets.
eval "$(python3 - <<'PY'
import http.cookiejar, json, os, secrets, shlex, urllib.request
origin = os.environ["VIVID_TEST_EXECUTOR_URL"]
cookies = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
def request(path, body=None):
    headers = {"Origin": origin, "Content-Type": "application/json"}
    data = None if body is None else json.dumps(body).encode()
    with client.open(urllib.request.Request(origin + path, data=data, headers=headers), timeout=120) as response:
        return json.load(response)
request("/api/auth/self-host/setup", {
    "name": "Disposable owner", "email": "executor-test@example.test",
    "password": secrets.token_urlsafe(32), "organizationName": "Disposable Integrations",
})
organizations = request("/api/auth/organization/list")
if len(organizations) != 1:
    raise SystemExit("Expected one disposable organization")
organization = organizations[0]["id"]
key = request("/api/auth/api-key/create", {
    "name": "Disposable Vivid proof", "expiresIn": 3600,
    "metadata": {"organization": organization},
})["key"]
print("export VIVID_TEST_EXECUTOR_ORGANIZATION=" + shlex.quote(organization))
print("export VIVID_TEST_EXECUTOR_KEY=" + shlex.quote(key))
PY
)"
test -n "$VIVID_TEST_EXECUTOR_KEY"
test -n "$VIVID_TEST_EXECUTOR_ORGANIZATION"

# A separate PostgreSQL instance grants the tests database-create/drop authority.
# Vitest migrates and clones its own template; no app env file or port 55433 is used.
PG_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PG_CONTAINER=$(docker run --detach --health-cmd "pg_isready --username postgres" \
  --health-interval 1s --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine)
VIVID_TEST_DATABASE_URL="postgres://postgres@$(docker port "$PG_CONTAINER" 5432/tcp)/postgres"
export VIVID_TEST_DATABASE_URL
wait_healthy "$PG_CONTAINER" "$PG_STARTED"

# Resolve the Person's token only for the test invocation. Never paste it into a command.
cd "$VIVID_SOURCE"
VIVID_LIVE_CONNECTIONS=1 VIVID_LIVE_GITHUB=1 VIVID_LIVE_ADDRESS_POLICY=1 \
  VIVID_LIVE_GOOGLE=1 VIVID_LIVE_PUBLIC_INTEGRATIONS=1 \
  VIVID_TEST_GITHUB_LOGIN="$(gh api user --jq .login)" \
  VIVID_TEST_GITHUB_ACCOUNT_ID="$(gh api user --jq .id)" \
  VIVID_TEST_GITHUB_TOKEN="$(gh auth token)" \
  pnpm exec vitest run --project @vivid/server --maxWorkers 1 \
  apps/server/src/connections/executor.live.test.ts \
  apps/server/src/connections/executorgithub.live.test.ts \
  apps/server/src/connections/executorread.live.test.ts \
  apps/server/src/connections/executorisolation.live.test.ts \
  apps/server/src/connections/addresspolicy.live.test.ts \
  apps/server/src/connections/keyed.live.test.ts \
  apps/server/src/connections/google.live.test.ts \
  apps/server/src/connections/public.live.test.ts

# EXIT removes only captured disposable container IDs and their temporary volumes.
```

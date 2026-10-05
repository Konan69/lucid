```sh
# Run from Vivid's repository root. Set EXECUTOR_SOURCE to your clean fork checkout first.
set -eu
set +x
VIVID_SOURCE="$PWD"
EXECUTOR_COMMIT=7f9cc0dbffd3000d47381fac3be82047bd589aad
test "$(git -C "$EXECUTOR_SOURCE" rev-parse HEAD)" = "$EXECUTOR_COMMIT"
git -C "$EXECUTOR_SOURCE" diff --quiet HEAD
EXECUTOR_IMAGE=executor-selfhost:fork-7f9cc0d
docker build --network=host --memory=6g \
  --build-arg "EXECUTOR_BUILD_VERSION=$EXECUTOR_COMMIT" \
  -f "$EXECUTOR_SOURCE/apps/hosted/self-host/Dockerfile" \
  -t "$EXECUTOR_IMAGE" "$EXECUTOR_SOURCE"

# Disposable resources only; never reuse a production or development data volume.
# This fork supports storage 4.0.0/4.0.1; beta.8 writes 4.0.5. Never attach its volume.
# Evidence: beta.8 image revision 4930a44 matches source export 1d6befb; compare
# packages/sdk/src/implementation/{storage-schema,storage-migrations,storage}.ts.
# makeExecutorStorage.checkMigration rejects an unregistered version before auth migrations.
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
  --publish 127.0.0.1::4400 \
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
VIVID_LIVE_GITHUB=1 VIVID_LIVE_ADDRESS_POLICY=1 \
  VIVID_TEST_GITHUB_TOKEN="$(gh auth token)" \
  pnpm exec vitest run --project @vivid/server --maxWorkers 1 \
  apps/server/src/connections/executorgithub.live.test.ts \
  apps/server/src/connections/executorread.live.test.ts \
  apps/server/src/connections/executorisolation.live.test.ts \
  apps/server/src/connections/addresspolicy.live.test.ts

# EXIT removes only captured disposable container IDs and their temporary volumes.
```

/**
 * Uploads the JavaScript source maps a Vivid build produced to Sentry, so error reports arrive
 * with readable stack frames instead of minified or bundled names. Run after a build that emitted
 * source maps:
 *
 *   node scripts/sentry-upload.mjs <project> <directory> [<directory> ...]
 *
 * The application builds call this with their own output directory and Sentry project name
 * (`apps/web`, `apps/desktop` and `apps/mobile/scripts/publish.mjs`). Only `project` and the
 * directories differ per app; the org, the credentials and the behaviour below are shared, which
 * is why this lives once at the root rather than once per app.
 *
 * Debug IDs, not release names, carry the matching. The bundlers stamp a debug ID into both the
 * bundle and its map — web and desktop builds run Sentry CLI's `inject` first, the phone's Metro
 * config injects one itself (`apps/mobile/metro.config.js`, the `@sentry/react-native` SDK's
 * serializer) — so Sentry pairs an event's frames with the uploaded map by that ID, with no
 * release or distribution name to agree on. A map uploaded without a release therefore still
 * symbolicates. `sourcemaps inject` is idempotent: an already-injected file keeps its ID.
 *
 * Without `SENTRY_AUTH_TOKEN` in the environment this exits 0 without uploading and says why, so
 * a build with no credentials does not fail; the map files stay on disk and nothing ships to
 * Sentry. A token with only the `project:write` scope is enough (`project:write` is the lowest
 * scope that may create artifacts for a project).
 *
 * Maps for the web app are emitted hidden (`vite.config.ts`): the map file ships with the deploy
 * but no comment in the bundle points at it, so a browser that fetches the bundle never learns
 * the map's address and the sources stay unlisted. Injection adds the debug ID into the bundle
 * text itself, which does not depend on that comment.
 */
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeProcess from 'node:process'

const [project, ...directories] = NodeProcess.argv.slice(2)
if (project === undefined || directories.length === 0) {
  console.error('Usage: node scripts/sentry-upload.mjs <project> <directory> [<directory> ...]')
  NodeProcess.exit(1)
}

/** The org every Vivid Sentry project lives in (`~/agency/vivid-lanes/sentry-account.env`). */
const org = 'vivid-7t'

if (NodeProcess.env.SENTRY_AUTH_TOKEN === undefined) {
  console.log(`sentry-upload: no SENTRY_AUTH_TOKEN, skipping the upload for ${project}`)
  NodeProcess.exit(0)
}

// Only directories that exist take part, so a build whose output layout misses one does not fail.
const uploaded = directories.filter((directory) => NodeFS.existsSync(directory))
if (uploaded.length === 0) {
  console.log(`sentry-upload: none of [${directories.join(', ')}] exists, nothing to upload`)
  NodeProcess.exit(0)
}

/**
 * The CLI binary this workspace installs at the root (`node_modules/.bin`), found from here and
 * not from `PATH`: an application build calls this script with its own working directory, where
 * the root's binaries are not on the path. When it is missing (a tree without the dependency
 * installed) the call falls back to `PATH`.
 */
const sentryCli = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '../node_modules/.bin/sentry-cli',
)

/**
 * Runs one Sentry CLI command and fails the script on a non-zero exit, so a half-uploaded set of
 * maps is visible instead of silent. The CLI reads `SENTRY_AUTH_TOKEN` itself.
 */
function sentry(args) {
  const result = NodeChildProcess.spawnSync(
    NodeFS.existsSync(sentryCli) ? sentryCli : 'sentry-cli',
    args,
    {
      stdio: 'inherit',
    },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) NodeProcess.exit(result.status ?? 1)
}

// `inject` stamps the debug ID into the bundles that have a map beside them (an artifact already
// carrying one keeps it), which is what pairs the uploads with the events later. `--ext` limits
// both commands to the kinds of files this repo produces; everything else stays untouched.
const extensions = ['--ext', 'js', '--ext', 'mjs', '--ext', 'cjs', '--ext', 'hbc', '--ext', 'map']
sentry(['sourcemaps', 'inject', ...extensions, ...uploaded])
sentry(['sourcemaps', 'upload', '--org', org, '--project', project, ...extensions, ...uploaded])
console.log(`sentry-upload: uploaded ${uploaded.join(', ')} to ${project}`)

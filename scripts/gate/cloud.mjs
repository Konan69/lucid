import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { runIdentifier } from './process.mjs'

/**
 * One connection for the push, the start and the stream: a second `ssh` reuses the first one's
 * socket and skips the handshake, which is most of a focused run's waiting.
 */
const sshOptions = [
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPath=~/.ssh/vivid-gate-%C',
  '-o',
  'ControlPersist=120',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ConnectTimeout=20',
]

/**
 * What the machine must not keep in its snapshots. A Boat machine snapshots every file under the
 * home directory each minute, counts a hard link as a full copy, and does not read .gitignore
 * (docs.boat.dev/snapshots: ".boxignore ... uses gitignore syntax, and its rules are relative to
 * the directory it sits in"). Seven warm trees with their dependency directories were 5.8 million
 * files and 117 GiB on 6 Oct 2026, more than the machine could be started with. Everything
 * listed is rebuilt from the lockfile or by a run.
 */
export const snapshotIgnore = ['node_modules/', '.cache/', '.turbo/', 'runs/', 'cache/']

/**
 * The machine's side of a run. The machine keeps a fixed, small number of warm trees, one per
 * gate it will run at once (one for every four cores), not one per branch: a tree is a worktree
 * of the repository the client pushes to, moved to the wanted commit by git, so its
 * dependencies and TypeScript build info stay, and Turbo's cache and the passed-test records are
 * one directory for every tree. A run takes the first free tree and waits when none is.
 * Dependencies are installed again only when a manifest, the lockfile or a patch changed.
 *
 * The run is detached from the connection and writes to a log; the client follows the log and
 * reads the exit code from a file that carries this run's identifier, so a dropped connection
 * loses nothing and an older run's result can never answer for this one.
 *
 * Memory is capped for this run and for all gate runs together where the machine's service
 * manager allows it: the machine does other work, and a gate must be the thing that is stopped.
 */
export const remoteScript = String.raw`
set -euo pipefail
sha="$1"; run="$2"; label="$3"; shift 3
home="$HOME/vivid-gate/fast"; log="$home/runs/$run.log"
mkdir -p "$home/trees" "$home/runs" "$home/cache/turbo"
printf '%s\n' @IGNORE@ > "$home/.boxignore"
find "$home/runs" -type f -mtime +2 -delete
find "$home/cache" -type f -mtime +7 -delete
cat > "$home/runs/$run.sh" <<'RUN'
set -uo pipefail
sha="$1"; run="$2"; label="$3"; shift 3
home="$HOME/vivid-gate/fast"
export PATH="$HOME/.local/bin:$PATH" HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1
export VIVID_GATE_CACHE="$home/cache/turbo"
finish() { echo "$1" > "$home/runs/$run.exit"; exit "$1"; }
cores=$(nproc); slots=$(( cores / 4 )); [ "$slots" -ge 1 ] || slots=1
slot=""
while [ -z "$slot" ]; do
  for index in $(seq 0 $(( slots - 1 ))); do
    exec 9>"$home/trees/slot-$index.lock"
    if flock -n 9; then slot="slot-$index"; break; fi
  done
  [ -n "$slot" ] || sleep 1
done
tree="$home/trees/$slot"
[ -d "$tree" ] || git --git-dir="$home/repo.git" worktree add -q --detach "$tree" "$sha" || finish 92
cd "$tree" || finish 92
git checkout -q --force --detach "$sha" && git clean -fdq || finish 92
mkdir -p .cache/gate
# A test of this script stops here: the tree is chosen and at the commit, nothing is installed.
[ -z "$(printenv VIVID_GATE_PREPARE_ONLY)" ] || { echo "$slot"; finish 0; }
# pnpm fetches the version this repository pins on first use, and that first call can fail
# while the download lands (seen after a machine woke with its cache gone). Ask twice.
pnpm --version > /dev/null 2>&1 || pnpm --version > /dev/null 2>&1 || true
stamp=$(git ls-tree -r "$sha" | grep -E '(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$|[[:space:]]patches/' | sha256sum | cut -c1-32)
if [ "$(cat .cache/gate/installed 2>/dev/null)" != "$stamp" ]; then
  echo "installing dependencies"
  pnpm install --frozen-lockfile > .cache/gate/install.log 2>&1 || { tail -20 .cache/gate/install.log; finish 90; }
  echo "$stamp" > .cache/gate/installed
fi
capped=""
if systemd-run --user --scope -q --slice=vividgate true 2>/dev/null; then
  systemctl --user set-property --runtime vividgate.slice MemoryHigh=9G MemoryMax=11G 2>/dev/null || true
  capped="systemd-run --user --scope -q --slice=vividgate -p MemoryMax=8G"
fi
$capped node scripts/gate.mjs "$@" --here --sha "$label"
finish $?
RUN
setsid nohup bash "$home/runs/$run.sh" "$sha" "$run" "$label" "$@" > "$log" 2>&1 < /dev/null &
echo $! > "$home/runs/$run.pid"
`.replace('@IGNORE@', snapshotIgnore.map((rule) => `'${rule}'`).join(' '))

/**
 * Follow the run's log until its exit file exists, then leave with the run's own exit code.
 * ssh itself exits 255 when the connection is lost, which no gate run does.
 */
export const followScript = String.raw`
home="$HOME/vivid-gate/fast"; run="$1"
touch "$home/runs/$run.log"
tail -n +1 -f "$home/runs/$run.log" &
tail=$!
runner="$(cat "$home/runs/$run.pid")"
# The runner's own process id, written when it started. A runner that was killed writes no exit
# file, so its absence with no live runner is a failure, not something to wait on.
while [ ! -f "$home/runs/$run.exit" ] && kill -0 "$runner" 2>/dev/null; do sleep 0.2; done
sleep 0.3; kill "$tail" 2>/dev/null; wait "$tail" 2>/dev/null
[ -f "$home/runs/$run.exit" ] || { echo "the run ended without a result"; exit 93; }
exit "$(cat "$home/runs/$run.exit")"
`

function git(root, args, environment) {
  return NodeChildProcess.spawnSync('git', args, { cwd: root, env: environment, encoding: 'utf8' })
}

/**
 * The commit to gate. With uncommitted work this is a commit of the working tree as it stands,
 * built through a temporary index: the real index, the branch and the stash list are untouched,
 * and nothing refers to the commit but the push that sends it.
 */
export function snapshot(root, environment, committed) {
  // Checked like every later step: a failed `status` prints nothing, which would read as a
  // clean tree and gate HEAD in place of the work on disk.
  const read = (args) => {
    const result = git(root, args, environment)
    if (result.status !== 0)
      throw new Error(`could not read the checkout (git ${args[0]}): ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
  const head = read(['rev-parse', 'HEAD'])
  const dirty = read(['status', '--porcelain']) !== ''
  if (committed || !dirty) return { sha: head, label: head.slice(0, 12) }
  const index = NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'gate-')), 'index')
  const scratch = { ...environment, GIT_INDEX_FILE: index }
  try {
    // Every step is checked: a failed `add` would leave HEAD's content in the index, and the
    // commit made from it would gate the tree without the change it was meant to carry.
    const step = (args, env) => {
      const result = git(root, args, env)
      if (result.status !== 0)
        throw new Error(`could not snapshot the tree (git ${args[0]}): ${result.stderr.trim()}`)
      return result.stdout.trim()
    }
    step(['read-tree', 'HEAD'], scratch)
    step(['add', '--all'], scratch)
    const tree = step(['write-tree'], scratch)
    const identity = ['-c', 'user.name=gate', '-c', 'user.email=gate@localhost']
    const commit = step(
      [...identity, 'commit-tree', tree, '-p', head, '-m', 'gate: working tree'],
      environment,
    )
    return { sha: commit, label: `${head.slice(0, 12)}+uncommitted` }
  } finally {
    NodeFS.rmSync(NodePath.dirname(index), { recursive: true, force: true })
  }
}

/** A tree name the machine can use as a directory: the branch, lower case, one word. */
export function treeName(root, environment, requested) {
  const branch =
    requested === undefined
      ? git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], environment).stdout.trim()
      : requested
  const name = branch
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  if (name === '' || name === 'head') throw new Error('give the tree a name with --name')
  return name
}

/** One argument as one shell word: ssh joins its arguments into a single remote command line. */
export function shellWord(argument) {
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

function ssh(host, script, args, stdio) {
  const words = args.map((argument) => shellWord(argument))
  return NodeChildProcess.spawnSync('ssh', [...sshOptions, host, 'bash', '-s', '--', ...words], {
    input: script,
    encoding: 'utf8',
    stdio,
  })
}

/**
 * git sends only the objects the machine lacks; the first push creates the repository. The push
 * hook is skipped: this push is how the gate reaches its tree, and the hook is the gate.
 */
function push(root, host, target, environment) {
  const remote = `ssh://${host}/~/vivid-gate/fast/repo.git`
  const env = { ...environment, GIT_SSH_COMMAND: `ssh ${sshOptions.join(' ')}` }
  const send = () => git(root, ['push', '--quiet', '--force', '--no-verify', remote, target], env)
  const first = send()
  if (first.status === 0) return
  const create = ssh(
    host,
    'mkdir -p ~/vivid-gate/fast && git init -q --bare ~/vivid-gate/fast/repo.git',
    [],
    'pipe',
  )
  const second = create.status === 0 ? send() : first
  if (second.status !== 0) throw new Error(`could not send the commit: ${second.stderr.trim()}`)
}

/**
 * Stream the run's output and return its exit code. A lost connection reconnects and prints the
 * log again from its start; only this run's identifier is ever asked for, so the code returned
 * is this run's or none.
 */
function follow(host, run) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const stream = ssh(host, followScript, [run], ['pipe', 'inherit', 'inherit'])
    if (stream.status !== null && stream.status !== 255) return stream.status
    process.stdout.write('connection lost; reconnecting\n')
  }
  throw new Error(`lost the connection to ${host}; run ${run} may still be going`)
}

/**
 * Why a machine may not run a gate, from what `ssh -G` says a host name resolves to; `undefined`
 * when it may.
 *
 * `cloudbox-vivid` (reached through `boat proxy vivid`) is the production
 * Vivid Computer of a Person's account. From 3 to 7 October 2026 the name `vivid-boat` pointed at
 * it and every gate ran there. The warm trees and caches filled its disk: Boat's snapshot of it
 * held 117.5 GiB in 5.8 million files, Boat refused every start ("needs 125.4 GiB of disk but
 * the largest 'large' machine holds 125.0 GiB"), and the Person's Vivid had no Computer. Before
 * that the same sharing woke the machine behind Vivid's back and had Vivid stop it under a
 * running gate.
 *
 * The check is on what the name resolves to, never on the name: an alias that is pointed at that
 * machine again is refused as well. A Person's Computer is never a build machine.
 */
export function refusedHost(resolved) {
  const hostname = /^hostname (?<value>.+)$/mu.exec(resolved)
  const proxy = /^proxycommand (?<value>.+)$/mu.exec(resolved)
  const names = hostname === null ? '' : hostname.groups.value.trim()
  const command = proxy === null ? '' : proxy.groups.value
  if (names === 'cloudbox-vivid' || /\bboat proxy vivid\b/u.test(command))
    return 'it is the production Vivid Computer (cloudbox-vivid), and a Person’s Computer never runs gates, builds or tests: use the CI machine (cloudbox-konan), or --here'
  return undefined
}

/** Ask ssh what a host name resolves to and stop before anything is sent to a refused machine. */
function admitHost(host) {
  const resolved = NodeChildProcess.spawnSync('ssh', ['-G', host], { encoding: 'utf8' })
  if (resolved.status !== 0) throw new Error(`ssh does not know the host ${host}`)
  const reason = refusedHost(resolved.stdout)
  if (reason !== undefined) throw new Error(`the gate will not run on ${host}: ${reason}`)
}

/**
 * Gate this checkout in its warm tree on `options.host`. The verdict line it prints is the
 * remote gate's own, and names the commit that was sent.
 */
export function runCloud(root, options, environment) {
  admitHost(options.host)
  const name = treeName(root, environment, options.name)
  const { sha, label } = snapshot(root, environment, options.committed)
  const run = `${name}-${runIdentifier()}`
  const started = Date.now()
  push(root, options.host, `${sha}:refs/gate/${name}`, environment)
  // An explicit base need not be an ancestor of the commit; the warm tree must have it to compare.
  if (options.base !== undefined)
    push(root, options.host, `${options.base}:refs/gate/${name}-base`, environment)
  if (options.ceilingsBase !== undefined && options.ceilingsBase !== options.base)
    push(root, options.host, `${options.ceilingsBase}:refs/gate/${name}-ceilings-base`, environment)
  const forwarded = [options.mode, ...(options.files === undefined ? [] : options.files)]
  if (options.only !== undefined) forwarded.push('--only', options.only)
  if (options.base !== undefined) forwarded.push('--base', options.base)
  if (options.ceilingsBase !== undefined) forwarded.push('--ceilings-base', options.ceilingsBase)
  if (options.proof !== undefined) {
    forwarded.push('--proof-branch', options.proof.branch)
    if (options.proof.enabled) forwarded.push('--proof-base', options.proof.base)
  }
  const start = ssh(options.host, remoteScript, [sha, run, label, ...forwarded], 'pipe')
  if (start.status !== 0) throw new Error(`could not start the run: ${start.stderr.trim()}`)
  const exit = follow(options.host, run)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write(`tree ${name} on ${options.host}, ${label}, ${seconds}s from command\n`)
  return exit
}

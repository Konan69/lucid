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
 * The machine's side of a run. It keeps one warm tree per name: a worktree of the repository
 * the client pushes to, moved to the new commit by git so unchanged files keep their content,
 * `node_modules`, TypeScript build info and Turbo logs. Dependencies are installed again only
 * when a manifest, the lockfile or a patch changed. Turbo's cache is one directory for every
 * tree, so a package another thread already checked is replayed.
 *
 * The run is detached from the connection and writes to a log; the client follows the log and
 * reads the exit code from a file that carries this run's identifier, so a dropped connection
 * loses nothing and an older run's result can never answer for this one.
 *
 * Memory is capped for this run and for all gate runs together where the machine's service
 * manager allows it: the machine does other work, and a gate must be the thing that is stopped.
 */
const remoteScript = String.raw`
set -euo pipefail
name="$1"; sha="$2"; run="$3"; label="$4"; shift 4
home="$HOME/vivid-gate/fast"; tree="$home/trees/$name"; log="$home/runs/$run.log"
export PATH="$HOME/.local/bin:$PATH" HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1
export VIVID_GATE_CACHE="$home/cache/turbo"
mkdir -p "$home/trees" "$home/runs" "$home/cache/turbo"
find "$home/runs" -type f -mtime +2 -delete
cat > "$home/runs/$run.sh" <<'RUN'
set -uo pipefail
name="$1"; sha="$2"; run="$3"; label="$4"; shift 4
home="$HOME/vivid-gate/fast"; tree="$home/trees/$name"
finish() { echo "$1" > "$home/runs/$run.exit"; exit "$1"; }
# The same name twice is one tree: the second run waits for the first.
exec 9>"$home/trees/$name.lock"; flock 9
[ -d "$tree" ] || git --git-dir="$home/repo.git" worktree add -q --detach "$tree" "$sha" || finish 92
cd "$tree" || finish 92
git checkout -q --force --detach "$sha" && git clean -fdq || finish 92
mkdir -p .cache/gate
stamp=$(git ls-tree -r "$sha" | grep -E '(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$|[[:space:]]patches/' | sha256sum | cut -c1-32)
if [ "$(cat .cache/gate/installed 2>/dev/null)" != "$stamp" ]; then
  echo "installing dependencies"
  pnpm install --frozen-lockfile > .cache/gate/install.log 2>&1 || { tail -20 .cache/gate/install.log; finish 90; }
  echo "$stamp" > .cache/gate/installed
fi
capped=""
if systemd-run --user --scope -q --slice=vividgate true 2>/dev/null; then
  systemctl --user set-property --runtime vividgate.slice MemoryMax=11G 2>/dev/null || true
  capped="systemd-run --user --scope -q --slice=vividgate -p MemoryMax=8G"
fi
$capped node scripts/gate.mjs "$@" --here --sha "$label"
finish $?
RUN
setsid nohup bash "$home/runs/$run.sh" "$name" "$sha" "$run" "$label" "$@" > "$log" 2>&1 < /dev/null &
echo $! > "$home/runs/$run.pid"
`

/**
 * Follow the run's log until its exit file exists, then leave with the run's own exit code.
 * ssh itself exits 255 when the connection is lost, which no gate run does.
 */
const followScript = String.raw`
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
  const head = git(root, ['rev-parse', 'HEAD'], environment).stdout.trim()
  const dirty = git(root, ['status', '--porcelain'], environment).stdout.trim() !== ''
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
 * Gate this checkout in its warm tree on `options.host`. The verdict line it prints is the
 * remote gate's own, and names the commit that was sent.
 */
export function runCloud(root, options, environment) {
  const name = treeName(root, environment, options.name)
  const { sha, label } = snapshot(root, environment, options.committed)
  const run = `${name}-${runIdentifier()}`
  const started = Date.now()
  push(root, options.host, `${sha}:refs/gate/${name}`, environment)
  const forwarded = [options.mode, ...(options.files === undefined ? [] : options.files)]
  if (options.only !== undefined) forwarded.push('--only', options.only)
  // The base is an ancestor of the commit just pushed, so the warm tree's repository has it.
  if (options.base !== undefined) forwarded.push('--base', options.base)
  const start = ssh(options.host, remoteScript, [name, sha, run, label, ...forwarded], 'pipe')
  if (start.status !== 0) throw new Error(`could not start the run: ${start.stderr.trim()}`)
  const exit = follow(options.host, run)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write(`tree ${name} on ${options.host}, ${label}, ${seconds}s from command\n`)
  return exit
}

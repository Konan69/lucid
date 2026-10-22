import * as NodeChildProcess from 'node:child_process'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const require = NodeModule.createRequire(import.meta.url)

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

/** One worker unless the caller named a count. */
const workersFrom = (setting) => (setting === undefined ? '1' : setting)

/**
 * Keep package checks in the root config's coordinate system: overrides and
 * design-plugin paths are root-relative. Each package owns its whole directory;
 * the root task covers only the remainder. Fixes explicitly select the whole
 * workspace and always bypass Turbo. One Oxlint worker and one default Go worker
 * keep caller overrides compatible; tsrslint owns its internal worker count.
 * The gate, which runs one lint process at a time, names more of each through
 * VIVID_LINT_THREADS and GOMAXPROCS.
 */
export function runLint(root, cwd, args, environment) {
  const scope = NodePath.relative(root, cwd).split(NodePath.sep).join('/')
  if (scope === '..' || scope.startsWith('../') || NodePath.isAbsolute(scope)) {
    process.stderr.write('lint must run inside the Vivid workspace\n')
    return 1
  }
  const wholeWorkspace = args.includes('--workspace')
  if (wholeWorkspace && scope !== '') {
    process.stderr.write('--workspace is only valid for the root fix command\n')
    return 1
  }
  const flags = [
    '--type-aware',
    `--threads=${workersFrom(environment.VIVID_LINT_THREADS)}`,
    ...args.filter((arg) => arg !== '--workspace'),
  ]
  if (scope === '' && !wholeWorkspace) {
    flags.push('--ignore-pattern', 'apps/**', '--ignore-pattern', 'packages/**')
  }
  flags.push(scope === '' ? '.' : scope)
  const backend = environment.OXLINT_TSGOLINT_PATH ?? require('@maschwenk/tsrslint').binaryPath()
  const goWorkers = workersFrom(environment.GOMAXPROCS)
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint'), ...flags],
    {
      cwd: root,
      env: { ...environment, GOMAXPROCS: goWorkers, OXLINT_TSGOLINT_PATH: backend },
      stdio: 'inherit',
    },
  )
  if (result.error !== undefined) {
    process.stderr.write(`could not start oxlint: ${result.error.message}\n`)
    return 1
  }
  if (result.status === null) return 1
  return result.status
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  process.exitCode = runLint(repositoryRoot, process.cwd(), process.argv.slice(2), process.env)
}

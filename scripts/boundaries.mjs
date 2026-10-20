import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const cases = {
  '05178e0b': ['apps/web/src/data/account.ts', 'apps/web/src/data/account.test.ts'],
  '7387315f': ['apps/mobile/scripts/publish.mjs', 'apps/server/src/updates/publishing.test.ts'],
  '138b9241': ['apps/mobile/scripts/publish.mjs', 'apps/server/src/updates/publishing.test.ts'],
  63938327: ['apps/mobile/scripts/publish.mjs', 'apps/server/src/updates/publishing.test.ts'],
  b75fcc75: ['apps/server/src/live/changes.ts', 'apps/server/src/live/limits.test.ts'],
  '7a00ed82': ['apps/server/src/live/changes.ts', 'apps/server/src/live/limits.test.ts'],
  efb82bd7: [
    'apps/server/src/observability/export.ts',
    'apps/server/src/observability/outcomes.test.ts',
  ],
}

/** Refuse an absent anchor instead of silently proving an unchanged consumer. */
function between(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from === -1 || to === -1) throw new Error(`Replay anchor missing: ${start}`)
  return source.slice(from, to)
}

/** Each replay restores the historical boundary decision while retaining today's import paths. */
function replay(fix, source, parent) {
  switch (fix) {
    case '05178e0b':
      return source.replace(
        between(source, 'const Session =', 'const Sessions ='),
        between(parent, 'const Session =', 'const Sessions ='),
      )
    case '7387315f':
    case '138b9241':
      return source.replace(
        between(source, 'const ExportedFiles =', 'for (const file of findMaps(directory))'),
        between(parent, 'const metadata = JSON.parse', 'for (const file of findMaps(directory))'),
      )
    case '63938327':
      return source.replace(
        'const versions = new Set(platforms.map(resolveRuntimeVersion))',
        between(parent, 'const versions = new Set(', 'if (versions.size !== 1)'),
      )
    case 'b75fcc75':
      return source.replace(
        between(source, 'export const announce =', '\n\n/**'),
        between(parent, 'export const announce =', '\n\n/**'),
      )
    case '7a00ed82':
      return source.replace(
        between(source, '  const publish =', '  const subscribe ='),
        between(parent, '  const publish =', '  const subscribe ='),
      )
    case 'efb82bd7':
      // The parent installs OtlpTracer directly. Reproduce that missing guard with the current
      // public make API, without restoring obsolete imports or unrelated serializer changes.
      if (!parent.includes('OtlpTracer.layer({')) throw new Error('Parent tracer changed')
      return source.replace('Effect.map(tracer, (inner) => guardedTracer(inner, keys))', 'tracer')
    default:
      throw new Error('Unknown boundary replay')
  }
}

/** Git output is data. No shell interpolation or application environment is needed. */
function git(directory, args) {
  const result = NodeChildProcess.spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout
}

/**
 * A private clone below this checkout's ignored cache keeps historical product code out of the
 * writer's tree. Include current uncommitted test files, then let the gate snapshot that clone
 * and provision its own disposable database on the selected devbox. Cleanup owns only this clone.
 */
function prove(fix, host) {
  if (!Object.hasOwn(cases, fix)) throw new Error('Choose a named historical boundary fix')
  if (!['cloudbox-konan', 'cloudbox-konan2', 'cloudbox-konan3'].includes(host)) {
    throw new Error('Pass --host with the devbox selected by devbox-pick')
  }
  const cache = NodePath.join(root, '.cache/boundaries')
  NodeFS.mkdirSync(cache, { recursive: true })
  const scratch = NodeFS.mkdtempSync(NodePath.join(cache, `${fix}-`))
  try {
    git(root, ['clone', '--shared', '--no-checkout', '--quiet', root, scratch])
    git(scratch, ['checkout', '--detach', '--quiet', 'HEAD'])
    const changed = git(root, ['diff', '--name-only', '-z', 'HEAD'])
    const added = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    for (const file of new Set(`${changed}${added}`.split('\0').filter(Boolean))) {
      const from = NodePath.join(root, file)
      const to = NodePath.join(scratch, file)
      if (!NodeFS.existsSync(from)) NodeFS.rmSync(to, { force: true })
      else {
        NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true })
        NodeFS.copyFileSync(from, to)
      }
    }
    NodeFS.symlinkSync(NodePath.join(root, 'node_modules'), NodePath.join(scratch, 'node_modules'))
    const [file, test] = cases[fix]
    const target = NodePath.join(scratch, file)
    const source = NodeFS.readFileSync(target, 'utf8')
    const parent = git(root, ['show', `${fix}^:${file}`])
    const restored = replay(fix, source, parent)
    if (restored === source) throw new Error('Replay did not change the consumer')
    NodeFS.writeFileSync(target, restored)
    console.log(`Restored ${fix} parent boundary in a scratch copy of ${file}`)
    const result = NodeChildProcess.spawnSync(
      'pnpm',
      ['gate', 'focused', test, '--host', host, '--name', `u14-${fix}`],
      {
        cwd: scratch,
        stdio: 'inherit',
      },
    )
    if (result.error !== undefined) throw result.error
    return result.status === null ? 1 : result.status
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true })
  }
}

const [fix, flag, host] = process.argv.slice(2)
if (flag !== '--host') throw new Error('Usage: node scripts/boundaries.mjs <fix> --host <devbox>')
process.exitCode = prove(fix, host)

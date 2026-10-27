import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const root = NodePath.resolve(directory, '../..')

/** Read committed objects only, so dirty files and the caller's cwd cannot change a verdict. */
function git(args) {
  return NodeChildProcess.execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}

if (process.argv.length !== 3) {
  console.error('Usage: node scripts/parity/check.mjs <ref>')
  process.exit(2)
}

const sha = git(['rev-parse', '--verify', '--end-of-options', `${process.argv[2]}^{commit}`])
const files = new Set(git(['ls-tree', '-r', '--name-only', sha]).split('\n'))
const contents = new Map()
const durable = files.has('packages/agent/durable/src/main.ts')

/** Missing paths are an expected parity result; corrupt or unreadable git objects still fail. */
function source(path) {
  if (!files.has(path)) return undefined
  if (!contents.has(path)) contents.set(path, git(['show', `${sha}:${path}`]))
  return contents.get(path)
}

/** Every probe must match; paths within a probe are explicit alternative implementations. */
function check(probe) {
  if ('any' in probe) return probe.any.map(check).find((match) => match !== undefined)
  if ('feature' in probe) {
    const path = `.agents/skills/verify-vivid/features/${probe.feature}.md`
    const map = source('.agents/skills/verify-vivid/features/README.md')
    return files.has(path) && map !== undefined && map.includes(`](${probe.feature}.md)`)
      ? path
      : undefined
  }
  const paths =
    durable && probe.paths.some((path) => path.startsWith('packages/agent/durable/'))
      ? probe.paths.filter((path) => !path.startsWith('packages/agent/runtime/'))
      : probe.paths
  const matched = paths.find((path) => {
    const text = source(path)
    // A forbidden placeholder is absent on main, which predates the RPC relay module.
    if ('lacks' in probe) return text === undefined || !text.includes(probe.lacks)
    if (text === undefined) return false
    return probe.text === undefined || text.includes(probe.text)
  })
  if (matched === undefined) return undefined
  return files.has(matched) ? matched : `${matched} (absent)`
}

const rows = NodeFS.readFileSync(NodePath.join(directory, 'behaviours.tsv'), 'utf8')
  .trimEnd()
  .split('\n')
const header = rows.shift()
if (header !== 'id\tbehaviour\tmain_commits\tsurface\tcheck' || rows.length === 0) {
  throw new Error('Unexpected parity checklist columns')
}
const ids = new Set()
let passed = 0
console.log(`STATIC ONLY ${process.argv[2]} ${sha}. PASS means markers exist; tests did not run.`)
for (const row of rows) {
  const columns = row.split('\t')
  const [id, behaviour, commits, surface, encoded] = columns
  if (columns.length !== 5 || columns.some((column) => column.length === 0) || ids.has(id)) {
    throw new Error(`Invalid or duplicate parity row: ${id}`)
  }
  ids.add(id)
  // oxlint-disable-next-line vivid/require-schema-decode-in-boundary -- This is repository-authored check data, not a product or network payload.
  const probes = JSON.parse(encoded)
  if (!Array.isArray(probes) || probes.length === 0) throw new Error(`No checks: ${id}`)
  const evidence = probes.map(check)
  const missing = probes.filter((_, index) => evidence[index] === undefined)
  const status = missing.length === 0 ? 'PASS' : 'MISSING'
  if (status === 'PASS') passed += 1
  console.log(
    `${status}\t${id}\t${behaviour}\t${commits}\t${surface}\t${
      status === 'PASS' ? evidence.join('; ') : JSON.stringify(missing)
    }`,
  )
}
console.log(
  `SUMMARY ${process.argv[2]} ${sha} PASS=${passed} MISSING=${ids.size - passed} TOTAL=${ids.size}`,
)
process.exitCode = passed === ids.size ? 0 : 1

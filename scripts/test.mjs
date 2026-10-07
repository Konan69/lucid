import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
/** Where the gate reads each package's counts; a Turbo output of the test task. */
const countsFile = '.cache/gate/tests.json'
/** Modules whose presence means a test starts other programs, which no import graph follows. */
const startsPrograms = /^(node:)?(child_process|worker_threads|cluster)$/u
/** A path made from the module's own location or the working directory: a file read by place. */
const readsByPlace = /import\.meta\.(url|dirname|filename)|__dirname|__filename|\.cwd\(\)/u
const usesFiles = /^(node:)?fs(\/promises)?$/u
/** Test code that touches the file system at all is taken to read fixtures the graph cannot see. */
const testCode = /(\.test\.[cm]?[jt]sx?$)|(\/tests\/)|(\/testing\.ts$)/u
/** An import whose target is computed when it runs, and a loader that bypasses the graph. */
const computedImport = /__vite_ssr_dynamic_import__\(\s*(?!["'`])/u
const ownLoader = /createRequire\(/u
const code = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u
const prose = /(^|\/)(README|AGENTS)\.md$/u

function digest(parts) {
  const hash = NodeCrypto.createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

/** Content digests by absolute path; a file is read once however many tests reach it. */
function contentReader() {
  const known = new Map()
  return (file) => {
    const cached = known.get(file)
    if (cached !== undefined) return cached
    const value = digest([NodeFS.readFileSync(file)])
    known.set(file, value)
    return value
  }
}

/**
 * Everything one module loads, from Vitest's own transform of it: static and dynamic imports as
 * Vite resolved them, so aliases, package exports and plugin-made modules (Flue's Markdown) are
 * followed exactly as the test run follows them. This is the walk `vitest --changed` does
 * (vitest 5.0.1 dist/chunks/index, `getAffectedModules`), kept forward instead of reversed.
 * Dependencies inside `node_modules` are not followed; the lockfile stands for them.
 */
async function moduleImports(project, file) {
  const environment = project.vite.environments.ssr
  const known = environment.moduleGraph.getModuleById(file)
  const transformed =
    known !== undefined && known.transformResult !== null && known.transformResult !== undefined
      ? known.transformResult
      : await environment.transformRequest(file)
  if (transformed === null || transformed === undefined) return { files: [], raw: [], code: '' }
  const raw = [
    ...(transformed.deps === undefined ? [] : transformed.deps),
    ...(transformed.dynamicDeps === undefined ? [] : transformed.dynamicDeps),
  ]
  const files = raw.flatMap((dependency) => {
    const path = dependency.startsWith('/@fs/')
      ? dependency.slice(4)
      : NodePath.join(project.config.root, dependency)
    return !path.includes('node_modules') && NodeFS.existsSync(path) ? [path] : []
  })
  return { files, raw, code: transformed.code }
}

/**
 * The import graph of a project, built once and shared by every test file in it. Each module
 * also records why it is "wide", when it is: it starts another program, reads files found by
 * place, is test code that uses the file system, imports a computed path, or loads modules by
 * its own means. What such a module depends on is not in any import graph, so a test that
 * reaches one is keyed on the whole package instead.
 */
function widthOf(file, raw, text, transformed) {
  if (raw.some((dependency) => startsPrograms.test(dependency))) return 'starts a program'
  const files = raw.some((dependency) => usesFiles.test(dependency))
  if (files && readsByPlace.test(text)) return 'reads files by place'
  if (files && testCode.test(file)) return 'test code using the file system'
  if (computedImport.test(transformed)) return 'computed import'
  if (ownLoader.test(text)) return 'own module loader'
  return undefined
}

function graphOf(project, read) {
  const nodes = new Map()
  const remembered = moduleMemory(project, read)
  const expand = async (file) => {
    const existing = nodes.get(file)
    if (existing !== undefined) return existing
    const pending = (async () => {
      const known = remembered.recall(file)
      if (known !== undefined) return known
      const { files, raw, code: transformed } = await moduleImports(project, file)
      const text = NodeFS.readFileSync(file, 'utf8')
      return remembered.keep({ files, wide: widthOf(file, raw, text, transformed), file })
    })()
    nodes.set(file, pending)
    return pending
  }
  return async (entry) => {
    const reached = new Set([entry])
    const queue = [entry]
    let wide
    while (queue.length > 0) {
      const batch = await Promise.all(queue.splice(0).map((file) => expand(file)))
      const widest = batch.find((node) => node.wide !== undefined)
      if (wide === undefined && widest !== undefined)
        wide = `${NodePath.relative(repositoryRoot, widest.file)} ${widest.wide}`
      const fresh = batch.flatMap((node) => node.files).filter((file) => !reached.has(file))
      for (const file of new Set(fresh)) {
        reached.add(file)
        queue.push(file)
      }
    }
    return { files: [...reached].toSorted((a, b) => a.localeCompare(b)), wide }
  }
}

/** One module's remembered imports: repository paths, and why it is wide when it is. */
const Remembered = Schema.Struct({
  files: Schema.Array(Schema.String),
  wide: Schema.optionalKey(Schema.String),
})
const decodeRemembered = Schema.decodeUnknownSync(Schema.fromJsonString(Remembered))

/**
 * What a module imports is a function of its own text and of how imports resolve. Transforming
 * the server's whole graph took about 20 seconds on every run that had to choose tests; so each
 * module's imports are remembered under its content and the resolution inputs (lockfile,
 * compiler configuration, the package's manifest and runner configuration), and a module that
 * did not change is not transformed again. A remembered import that no longer exists means the
 * layout moved under an unchanged importer, and that module is transformed afresh.
 */
function moduleMemory(project, read) {
  const root = project.config.root
  const resolution = digest(
    [
      NodePath.join(repositoryRoot, 'pnpm-lock.yaml'),
      NodePath.join(repositoryRoot, 'tsconfig.base.json'),
      NodePath.join(repositoryRoot, 'scripts/test.mjs'),
      ...NodeFS.readdirSync(root)
        .filter((name) =>
          /^(tsconfig.*\.json|package\.json|(vitest|vite)\.config\..*)$/u.test(name),
        )
        .map((name) => NodePath.join(root, name)),
    ].map((file) => read(file)),
  )
  const directory = NodePath.join(NodePath.dirname(storeDirectory()), 'graph')
  NodeFS.mkdirSync(directory, { recursive: true })
  const place = (file) =>
    NodePath.join(
      directory,
      `${digest([resolution, NodePath.relative(repositoryRoot, file), read(file)])}.json`,
    )
  return {
    recall: (file) => {
      const stored = place(file)
      if (!NodeFS.existsSync(stored)) return undefined
      const known = decodeRemembered(NodeFS.readFileSync(stored, 'utf8'))
      const files = known.files.map((relative) => NodePath.join(repositoryRoot, relative))
      if (files.some((path) => !NodeFS.existsSync(path))) return undefined
      return { files, wide: known.wide, file }
    },
    keep: (node) => {
      const files = node.files.map((path) => NodePath.relative(repositoryRoot, path))
      NodeFS.writeFileSync(
        place(node.file),
        JSON.stringify(node.wide === undefined ? { files } : { files, wide: node.wide }),
      )
      return node
    },
  }
}

/**
 * What every test file of the package depends on without importing it: the lockfile (every
 * external dependency), the compiler and runner configuration, the setup files and what they
 * load, the test settings in the environment, and every tracked file in the package that is
 * not code. A fixture, a migration or a Markdown skill read from disk changes this, and with it
 * every key in the package. The database address is left out: it differs on every run.
 */
async function packageInputs(project, closure, read) {
  const root = project.config.root
  const listed = NodeChildProcess.spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (listed.status !== 0) throw new Error(`could not list the package's files: ${listed.stderr}`)
  const data = listed.stdout
    .split('\n')
    .filter((file) => file !== '' && !prose.test(file))
    .filter((file) => !code.test(file) || /(^|\/)(vitest|vite)\.config\./u.test(file))
    .map((file) => NodePath.join(root, file))
    .filter((file) => NodeFS.existsSync(file))
  const setups = [
    ...project.config.setupFiles,
    ...(project.config.globalSetup === undefined ? [] : project.config.globalSetup),
  ]
  const setupFiles = (await Promise.all(setups.map((file) => closure(file)))).flatMap(
    (reached) => reached.files,
  )
  const shared = ['pnpm-lock.yaml', 'tsconfig.base.json', 'scripts/test.mjs'].map((file) =>
    NodePath.join(repositoryRoot, file),
  )
  const settings = Object.entries(process.env)
    .filter(([name]) => /^(VIVID_TEST_|VIVID_LIVE_|EXPLABS_API_KEY$)/u.test(name))
    // Neither changes what a test does: the address differs per run, and "run everything"
    // must write the same records a selective run reads.
    .filter(([name]) => name !== 'VIVID_TEST_DATABASE_URL' && name !== 'VIVID_TEST_ALL')
    .map(([name, value]) => `${name}=${value}`)
    .toSorted((a, b) => a.localeCompare(b))
  const files = [...new Set([...shared, ...data, ...setupFiles])].toSorted((a, b) =>
    a.localeCompare(b),
  )
  return digest([
    process.versions.node.split('.')[0],
    ...settings,
    ...files.flatMap((file) => [NodePath.relative(repositoryRoot, file), read(file)]),
  ])
}

/**
 * The key of one test file: the package's inputs and the content of every module the file
 * loads, by repository path, so the same sources give the same key in any checkout. A wide file
 * adds Turbo's hash of the whole task (the package, its dependencies' sources and the declared
 * integration edges); outside Turbo it has no key and always runs.
 */
function keyOf(reached, inputs, read) {
  if (reached.wide !== undefined && process.env.TURBO_HASH === undefined) return undefined
  return digest([
    inputs,
    reached.wide === undefined ? 'narrow' : process.env.TURBO_HASH,
    ...reached.files.flatMap((file) => [NodePath.relative(repositoryRoot, file), read(file)]),
  ])
}

/** A passed file's record: the counts the verdict needs when the file is replayed. */
const Passed = Schema.Struct({
  file: Schema.String,
  tests: Schema.Number,
  skipped: Schema.Number,
})
const decodePassed = Schema.decodeUnknownSync(Schema.fromJsonString(Passed))
/** The part of Vitest's JSON report that says how each file went. */
const Report = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      assertionResults: Schema.Array(Schema.Struct({ status: Schema.String })),
    }),
  ),
})
const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report))

/** One directory for every checkout on a machine when the gate names it; else this checkout's. */
function storeDirectory() {
  const shared = process.env.VIVID_GATE_CACHE
  const directory =
    shared === undefined
      ? NodePath.join(repositoryRoot, '.cache/gate/passed')
      : NodePath.join(NodePath.dirname(shared), 'passed')
  NodeFS.mkdirSync(directory, { recursive: true })
  return directory
}

function recalled(store, key) {
  if (key === undefined) return undefined
  const file = NodePath.join(store, `${key}.json`)
  return NodeFS.existsSync(file) ? decodePassed(NodeFS.readFileSync(file, 'utf8')) : undefined
}

/** Keys for every test file of the package in the current directory, from Vitest's own graph. */
async function plan(packageRoot) {
  const require = NodeModule.createRequire(NodePath.join(packageRoot, 'package.json'))
  const { createVitest } = await import(NodeURL.pathToFileURL(require.resolve('vitest/node')).href)
  const vitest = await createVitest('test', { watch: false, root: packageRoot })
  try {
    const read = contentReader()
    const specifications = await vitest.globTestSpecifications()
    const closures = new Map()
    const inputs = new Map()
    const planned = []
    for (const specification of specifications) {
      const project = specification.project
      if (!closures.has(project)) {
        closures.set(project, graphOf(project, read))
        inputs.set(project, await packageInputs(project, closures.get(project), read))
      }
      const reached = await closures.get(project)(specification.moduleId)
      planned.push({
        file: specification.moduleId,
        wide: reached.wide,
        key: keyOf(reached, inputs.get(project), read),
      })
    }
    return planned
  } finally {
    await vitest.close()
  }
}

/** Run the named files with the ordinary Vitest command line and read how each one went. */
function run(packageRoot, files, forwarded) {
  const report = NodePath.join(packageRoot, '.cache/gate/ran.json')
  NodeFS.rmSync(report, { force: true })
  const require = NodeModule.createRequire(NodePath.join(packageRoot, 'package.json'))
  const vitest = NodePath.join(
    NodePath.dirname(require.resolve('vitest/package.json')),
    'vitest.mjs',
  )
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      ...files.map((file) => NodePath.relative(packageRoot, file)),
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
      ...forwarded,
    ],
    { cwd: packageRoot, stdio: 'inherit' },
  )
  const results = NodeFS.existsSync(report)
    ? decodeReport(NodeFS.readFileSync(report, 'utf8')).testResults
    : []
  return { exit: result.status === null ? 1 : result.status, results }
}

const skippedStates = new Set(['pending', 'skipped', 'todo'])

/**
 * Add what just ran to the counts, and record each file that passed under its key so the next
 * run with the same inputs replays it. A failed file is never recorded.
 */
function record(results, due, store) {
  const counts = { tests: 0, skipped: 0 }
  for (const result of results) {
    const tests = result.assertionResults.length
    const skipped = result.assertionResults.filter((a) => skippedStates.has(a.status)).length
    counts.tests += tests
    counts.skipped += skipped
    const entry = due.find((candidate) => candidate.file === result.name)
    if (result.status === 'passed' && entry !== undefined && entry.key !== undefined)
      NodeFS.writeFileSync(
        NodePath.join(store, `${entry.key}.json`),
        JSON.stringify({ file: NodePath.relative(repositoryRoot, result.name), tests, skipped }),
      )
  }
  return counts
}

/** The files whose key already passed, with the counts they had; none when trusting nothing. */
function unchanged(planned, store, everything) {
  if (everything) return []
  return planned.flatMap((entry) => {
    const passed = recalled(store, entry.key)
    return passed === undefined
      ? []
      : [{ file: entry.file, tests: passed.tests, skipped: passed.skipped }]
  })
}

/**
 * Run only the test files whose result can have changed. A file's result is a function of what
 * it loads; when every byte of that is what it was the last time the file passed, the result is
 * replayed with its counts and the file does not run. `--all` runs everything and trusts
 * nothing: the default branch's own check uses it, so a dependency this file cannot see
 * (a path built from the working directory, say) is caught there at the latest.
 */
async function main(argv) {
  const packageRoot = process.cwd()
  const everything = argv.includes('--all') || process.env.VIVID_TEST_ALL === '1'
  const forwarded = argv.filter((argument) => argument !== '--all' && argument !== '--plan')
  const store = storeDirectory()
  const planned = await plan(packageRoot)
  const replayed = unchanged(planned, store, everything)
  const replayedFiles = new Set(replayed.map((entry) => entry.file))
  const due = planned.filter((entry) => !replayedFiles.has(entry.file))
  process.stdout.write(
    `tests: ${due.length} of ${planned.length} files to run, ${replayed.length} unchanged since they passed (${planned.filter((entry) => entry.wide !== undefined).length} files depend on the whole package)\n`,
  )
  if (argv.includes('--plan')) {
    for (const entry of planned.filter((candidate) => candidate.wide !== undefined))
      process.stdout.write(
        `  whole package: ${NodePath.relative(packageRoot, entry.file)} (${entry.wide})\n`,
      )
    return 0
  }
  const ran =
    due.length === 0
      ? { exit: 0, results: [] }
      : run(
          packageRoot,
          due.map((entry) => entry.file),
          forwarded,
        )
  const counts = record(ran.results, due, store)
  for (const entry of replayed) {
    counts.tests += entry.tests
    counts.skipped += entry.skipped
  }
  // A run that ended before its report, or without one of its files, is a failure, never a pass.
  // (A base narrows the run on purpose, so files Vitest left out are expected then.)
  const narrowed = forwarded.some((argument) => argument.startsWith('--changed'))
  const missing = narrowed ? 0 : due.length - ran.results.length
  NodeFS.mkdirSync(NodePath.join(packageRoot, '.cache/gate'), { recursive: true })
  NodeFS.writeFileSync(
    NodePath.join(packageRoot, countsFile),
    JSON.stringify({
      numTotalTests: counts.tests,
      numPendingTests: counts.skipped,
      numTodoTests: 0,
      testResults: planned.map((entry) => NodePath.relative(repositoryRoot, entry.file)),
    }),
  )
  if (ran.exit === 0 && missing > 0) {
    process.stderr.write(`${missing} test files did not report a result\n`)
    return 1
  }
  return ran.exit
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) process.exitCode = await main(process.argv.slice(2))

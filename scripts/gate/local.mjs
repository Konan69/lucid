import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { checkRaises, checkTightCeilings } from '../ceilings.mjs'
import { openRunDatabase } from './database.mjs'
import * as Schema from 'effect/Schema'
import { logged, readTestCounts, runIdentifier, stopChildrenOnSignal } from './process.mjs'
import { checkRatchets, effectRule } from './ratchets.mjs'
import { holdSlot, takeLock, treeLockName } from './slots.mjs'
import { stageOfTask, stages } from './stages.mjs'

/** Where Vitest writes each package's counts; a Turbo output, so a cache hit restores it. */
const testResult = '.cache/gate/tests.json'

/** The part of Turbo's run summary (`--summarize`, Turbo 2.11.2) that the report is built from. */
const TurboSummary = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      task: Schema.String,
      logFile: Schema.String,
      directory: Schema.String,
      cache: Schema.Struct({ status: Schema.String }),
      execution: Schema.Struct({
        startTime: Schema.Number,
        endTime: Schema.Number,
        exitCode: Schema.Number,
      }),
    }),
  ),
})
const decodeTurboSummary = Schema.decodeUnknownSync(Schema.fromJsonString(TurboSummary))

/** Policy checks are independent readers of the repository, so they run together. */
async function runCommands(stage, run) {
  const log = NodePath.join(run.directory, `${stage.name}.log`)
  const results = await Promise.all(
    stage.commands.map((command) => logged(command, { cwd: run.root, env: run.env, log })),
  )
  const failed = stage.commands
    .filter((_, index) => results[index].exit !== 0)
    .map((command) => command.join(' '))
  return [
    {
      name: stage.name,
      seconds: Math.max(...results.map((result) => result.seconds)),
      failed,
      detail: `${stage.commands.length} checks`,
      log,
    },
  ]
}

/** Turbo names each run summary itself; the new file in its directory is this invocation's. */
function newSummary(root, before, tasks) {
  const directory = NodePath.join(root, '.turbo/runs')
  if (!NodeFS.existsSync(directory)) return undefined
  return NodeFS.readdirSync(directory)
    .filter((file) => file.endsWith('.json') && !before.has(file))
    .map((file) => decodeTurboSummary(NodeFS.readFileSync(NodePath.join(directory, file), 'utf8')))
    .find((summary) =>
      summary.tasks.some((task) => tasks.includes(task.task) || tasks.includes(task.taskId)),
    )
}

function existingSummaries(root) {
  const directory = NodePath.join(root, '.turbo/runs')
  return new Set(NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory) : [])
}

/** A stage's line from the tasks Turbo ran or replayed for it. */
export function stageResult(stage, tasks, run) {
  const real = tasks
  const executed = real.filter((task) => task.cache.status !== 'HIT')
  const failed = real.filter((task) => task.execution.exitCode !== 0).map((task) => task.taskId)
  const log = NodePath.join(run.directory, `${stage.name}.log`)
  // Turbo keeps each task's output beside its package and restores it on a cache hit.
  const output = real
    .map((task) => NodePath.join(run.root, task.logFile))
    .filter((file) => NodeFS.existsSync(file))
    .map((file) => NodeFS.readFileSync(file, 'utf8'))
    .join('\n')
  // A partial log cannot prove a lower count. Keep missing lint receipts as failures.
  if (stage.name === 'lint') {
    for (const task of real) {
      if (!NodeFS.existsSync(NodePath.join(run.root, task.logFile)))
        failed.push(`missing lint log for ${task.taskId}`)
    }
  }
  NodeFS.writeFileSync(log, output)
  // The time the stage's own tasks ran: a lane interleaves stages, so a span would count others.
  const seconds =
    executed.reduce((sum, task) => sum + task.execution.endTime - task.execution.startTime, 0) /
    1000
  const cached = real.length - executed.length
  return {
    name: stage.name,
    seconds,
    failed,
    detail: `${cached}/${real.length} cached`,
    log,
    output,
    findings: effectFindings(real, run.root),
  }
}

/**
 * Effect findings, once each: a package's declaration and test projects both check its
 * production files, so the same line can be printed by two of its tasks.
 */
function effectFindings(tasks, root) {
  return new Set(
    tasks.flatMap((task) => {
      const file = NodePath.join(root, task.logFile)
      if (!NodeFS.existsSync(file)) return []
      return NodeFS.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => effectRule(line) !== undefined)
        .map((line) => `${task.directory}/${line.trim()}`)
    }),
  )
}

/**
 * What each package's test runner (`scripts/test.mjs`) is given. It writes the counts the verdict
 * reads and runs only the test files whose inputs changed since they passed. With a base, Vitest
 * further narrows to files whose imports reach a file changed since that commit.
 */
function testArguments(base) {
  return base === undefined ? [] : ['--', `--changed=${base}`, '--passWithNoTests']
}

/**
 * One Turbo invocation for one lane. `--continue=always` so every failing stage is reported in
 * one run, not only the first. The summary carries each task's cache status, times and log.
 */
async function runLane(lane, laneStages, run) {
  const tasks = laneStages.flatMap((stage) => stage.tasks)
  const before = existingSummaries(run.root)
  const concurrency = lane === 'checks' ? '1' : String(run.testTasks)
  const forwarded = lane === 'tests' ? testArguments(run.base) : []
  const turbo = await logged(
    [
      'node',
      'node_modules/turbo/bin/turbo',
      'run',
      ...tasks,
      `--concurrency=${concurrency}`,
      '--continue=always',
      '--summarize',
      '--log-order=grouped',
      ...run.cache,
      ...forwarded,
    ],
    { cwd: run.root, env: run.env, log: NodePath.join(run.directory, `turbo-${lane}.log`) },
  )
  const summary = newSummary(run.root, before, tasks)
  if (summary === undefined)
    return laneStages.map((stage) => ({
      name: stage.name,
      seconds: turbo.seconds,
      failed: ['turbo wrote no summary'],
      detail: 'turbo did not run',
      log: NodePath.join(run.directory, `turbo-${lane}.log`),
    }))
  const results = laneStages.map((stage) =>
    stageResult(
      stage,
      summary.tasks.filter((task) => stageOfTask(task.taskId) === stage),
      run,
    ),
  )
  // Turbo's own exit is the authority. A task outside every stage (a prerequisite another
  // package's configuration adds) can fail while each stage's own tasks pass; that failure
  // belongs to the lane, so it is charged to the lane's first stage and never dropped.
  if (turbo.exit !== 0 && results.every((result) => result.failed.length === 0)) {
    const strays = summary.tasks
      .filter((task) => task.execution.exitCode !== 0)
      .map((task) => task.taskId)
    results[0].failed.push(...strays, `turbo exited ${turbo.exit}`)
    results[0].log = NodePath.join(run.directory, `turbo-${lane}.log`)
  }
  return results
}

/**
 * Reject raised ceilings and compare them with the combined fresh and cached lint counts.
 * Reusing the task logs enforces exact ceilings without running the linter a second time.
 */
export function applyRatchets(results, run) {
  const lint = results.find((result) => result.name === 'lint')
  if (lint === undefined || lint.output === undefined) return
  const complete = lint.failed.length === 0
  const measurements = checkRatchets(lint.output)
  lint.failed.push(...checkRaises(run.root, run.ceilingsBase, run.env))
  for (const ratchet of measurements.filter((entry) => !entry.held))
    lint.failed.push(`${ratchet.label} ratchet: ${ratchet.count} exceed ${ratchet.ceiling}`)
  // A failed linter may have stopped early. It cannot justify lowering a ceiling.
  if (complete) lint.failed.push(...checkTightCeilings(measurements))
}

/**
 * Say how many Effect findings typecheck printed. Each one fails typecheck by itself
 * (`ignoreEffect...InTscExitCode` are `false`, held there by scripts/versions.mjs); the count on
 * the stage line says how many there are to fix without reading the log.
 */
function reportEffectFindings(results) {
  const typecheck = results.find((result) => result.name === 'typecheck')
  if (typecheck === undefined || typecheck.findings === undefined) return
  typecheck.detail += `, ${typecheck.findings.size} Effect findings`
}

/** Total and skipped tests across every package's Vitest result, cached or just run. */
function testCounts(root, directories) {
  const counts = { tests: 0, skipped: 0, files: 0 }
  for (const directory of directories) {
    const result = readTestCounts(NodePath.join(root, directory, testResult))
    counts.tests += result.tests
    counts.skipped += result.skipped
    counts.files += result.files
  }
  return counts
}

/** Every workspace directory, read from the manifests pnpm resolves. */
function workspaceDirectories(root) {
  const found = []
  for (const group of ['apps', 'packages']) {
    const pending = [NodePath.join(root, group)]
    while (pending.length > 0) {
      const directory = pending.pop()
      if (NodeFS.existsSync(NodePath.join(directory, 'package.json'))) {
        found.push(NodePath.relative(root, directory))
        continue
      }
      const children = NodeFS.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => NodePath.join(directory, entry.name))
      pending.push(...children)
    }
  }
  return found
}

/**
 * Run the selected stages in this tree. Policy, the checks lane and the tests lane start
 * together. The database is one empty database for this run alone and is dropped when the run
 * ends, pass or fail; without one the gate fails here instead of skipping the database suites.
 */
export async function runLocal(root, selection, environment) {
  const runId = runIdentifier()
  const directory = NodePath.join(root, '.cache/gate/runs', runId)
  NodeFS.mkdirSync(directory, { recursive: true })
  // One gate at a time in one tree: two would run Turbo over the same outputs and could each
  // read the other's run summary.
  const releaseTree = await takeLock(treeLockName(root))
  if (releaseTree === undefined) throw new Error('a gate is already running in this tree')
  try {
    const releaseSlot = await holdSlot((message) => process.stdout.write(`${message}\n`))
    try {
      return await runStages(root, selection, environment, { runId, directory })
    } finally {
      releaseSlot()
    }
  } finally {
    releaseTree()
  }
}

/**
 * Lint stays one package at a time. Oxlint uses up to four workers, never more than half
 * the machine; tsrslint owns its internal worker count. An explicit VIVID_LINT_THREADS wins.
 */
function lintWorkers(environment) {
  const workers = String(Math.max(1, Math.min(4, Math.floor(NodeOS.availableParallelism() / 2))))
  return {
    VIVID_LINT_THREADS:
      environment.VIVID_LINT_THREADS === undefined ? workers : environment.VIVID_LINT_THREADS,
  }
}

/** Execute stages inside an owned run directory. Production callers enter through runLocal's
 * capacity lease; lightweight tooling fixtures use this seam so they cannot deadlock their
 * parent gate by requesting another machine slot while every slot is occupied. */
export async function runStages(root, selection, environment, { runId, directory }) {
  const selected = stages.filter((stage) => selection.stages.includes(stage.name))
  // Proof exercises the gate's own database leases against the same disposable server.
  const needsDatabase = selected.some((stage) => stage.name === 'test' || stage.name === 'proof')
  const database = needsDatabase ? await openRunDatabase(root, environment, runId) : undefined
  stopChildrenOnSignal(() => (database === undefined ? Promise.resolve() : database.close()))
  const env = {
    ...environment,
    CI: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    ...lintWorkers(environment),
  }
  // The gate also builds uncommitted snapshots. No task or prerequisite may upload their maps.
  delete env.SENTRY_AUTH_TOKEN
  delete env.VIVID_TEST_DATABASE_URL
  // Remote trees are detached; the local caller resolved the branch and its comparison commit.
  if (selection.proof !== undefined) {
    env.VIVID_PROOF_BRANCH = selection.proof.branch
    env.VIVID_PROOF_ENABLED = selection.proof.enabled ? '1' : '0'
    if (selection.proof.enabled) env.VIVID_PROOF_BASE = selection.proof.base
  }
  if (database !== undefined) {
    env.VIVID_TEST_DATABASE_URL = database.url
    // The address differs on every run, so it stays out of the task hash; this marker is what
    // separates a result with database suites from one where they were skipped.
    env.VIVID_TEST_DATABASE = 'disposable'
  }
  // A flag, not TURBO_CACHE_DIR: the tooling tests run Turbo in fixtures of their own and inherit
  // the environment, so a cache named there would answer for their probes too.
  const cache =
    environment.VIVID_GATE_CACHE === undefined
      ? []
      : [`--cache-dir=${environment.VIVID_GATE_CACHE}`]
  const run = {
    root,
    directory,
    env,
    cache,
    base: selection.base,
    ceilingsBase: selection.ceilingsBase,
    testTasks: Math.max(2, Math.floor(NodeOS.availableParallelism() / 2)),
  }
  const started = Date.now()
  try {
    const lanes = ['checks', 'tests'].flatMap((lane) => {
      const laneStages = selected.filter((stage) => stage.lane === lane)
      return laneStages.length === 0 ? [] : [[lane, laneStages]]
    })
    const groups = await Promise.all([
      ...selected.filter((stage) => stage.commands !== undefined).map((s) => runCommands(s, run)),
      ...lanes.map(([lane, laneStages]) => runLane(lane, laneStages, run)),
    ])
    const results = groups.flat()
    applyRatchets(results, run)
    reportEffectFindings(results)
    const order = stages.map((stage) => stage.name)
    results.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name))
    return {
      runId,
      directory,
      results,
      seconds: (Date.now() - started) / 1000,
      counts: needsDatabase ? testCounts(root, workspaceDirectories(root)) : undefined,
    }
  } finally {
    if (database !== undefined) await database.close()
  }
}

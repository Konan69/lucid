import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { openRunDatabase } from './database.mjs'
import * as Schema from 'effect/Schema'
import { logged, readTestCounts, runIdentifier, stopChildrenOnSignal } from './process.mjs'
import { checkRatchets } from './ratchets.mjs'
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
    .find((summary) => summary.tasks.some((task) => tasks.includes(task.task)))
}

function existingSummaries(root) {
  const directory = NodePath.join(root, '.turbo/runs')
  return new Set(NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory) : [])
}

/** A stage's line from the tasks Turbo ran or replayed for it. */
function stageResult(stage, tasks, run) {
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
  }
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

/** Lint passes with warnings; the ratchets are what turn a new warning into a failure. */
function applyRatchets(results) {
  const lint = results.find((result) => result.name === 'lint')
  if (lint === undefined || lint.output === undefined) return
  const broken = checkRatchets(lint.output).filter((ratchet) => !ratchet.held)
  for (const ratchet of broken)
    lint.failed.push(`${ratchet.label} ratchet: ${ratchet.count} exceed ${ratchet.ceiling}`)
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

async function runStages(root, selection, environment, { runId, directory }) {
  const selected = stages.filter((stage) => selection.stages.includes(stage.name))
  const needsDatabase = selected.some((stage) => stage.lane === 'tests')
  const database = needsDatabase ? await openRunDatabase(root, environment, runId) : undefined
  stopChildrenOnSignal(() => (database === undefined ? Promise.resolve() : database.close()))
  const env = { ...environment, CI: '1', TURBO_TELEMETRY_DISABLED: '1' }
  delete env.VIVID_TEST_DATABASE_URL
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
    applyRatchets(results)
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

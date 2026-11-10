#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import { snapshot } from './gate/cloud.mjs'
import { openRunDatabase } from './gate/database.mjs'
import { logged, runIdentifier, stopChildrenOnSignal } from './gate/process.mjs'
import { vitestGroups } from './gate/vitest.mjs'
import { needsDatabase } from './proof/database.mjs'
import { judgeCase, readReceipt } from './proof/report.mjs'
import { caseBody, changedLines, leafBodies, testBodies } from './proof/source.mjs'
import { scratchTree } from './proof/tree.mjs'

const repositoryRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL('../', import.meta.url)))
const testPath = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/u
const cleanups = new Set()

/** Failed Git commands cannot silently turn a branch's diff into an empty proof. */
function git(root, args, input) {
  const result = NodeChildProcess.spawnSync('git', args, {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`proof: git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** Resolve on the caller: warm trees are detached and do not own an origin/main ref. */
export function proofSelection(root, options) {
  const branch =
    options['proof-branch'] === undefined
      ? git(root, ['branch', '--show-current']).trim()
      : options['proof-branch']
  const forced =
    options.only !== undefined &&
    options.only
      .split(',')
      .map((name) => name.trim())
      .includes('proof')
  const enabled = branch.startsWith('fix/') || forced
  if (!enabled || options.mode === 'focused') return { enabled: false, branch }
  const base =
    options['proof-base'] === undefined
      ? git(root, ['merge-base', 'HEAD', 'origin/main']).trim()
      : git(root, ['rev-parse', '--verify', `${options['proof-base']}^{commit}`]).trim()
  // The comparison must be an ancestor, which also ensures the remote snapshot carries it.
  git(root, ['merge-base', '--is-ancestor', base, 'HEAD'])
  return { enabled: true, branch, base }
}

/** Node tooling and Vitest packages keep their real runner and package-local setup. */
async function runTests(run) {
  const reports = []
  let exit = 0
  for (const [index, group] of run.groups.entries()) {
    const report = NodePath.join(run.directory, `${run.phase}-${group.kind}-${index}.json`)
    const reporter = NodePath.join(repositoryRoot, `scripts/proof/${group.kind}.mjs`)
    const args =
      group.kind === 'node'
        ? ['--test', `--test-reporter=${reporter}`, ...group.files]
        : [
            group.runner,
            'run',
            ...group.files,
            '--includeTaskLocation',
            '--maxWorkers=1',
            '--reporter=default',
            `--reporter=${reporter}`,
          ]
    const database = needsDatabase(group.cwd, group.files)
      ? await openRunDatabase(repositoryRoot, run.env, runIdentifier())
      : undefined
    // Signal cleanup closes this phase's database before removing its scratch source.
    const closeDatabase = async () => {
      if (database !== undefined) await database.close()
    }
    cleanups.add(closeDatabase)
    try {
      const env = { ...run.env, CI: '1', VIVID_PROOF_REPORT: report }
      // A proof may itself be exercised by node:test; its child is a separate runner.
      delete env.NODE_TEST_CONTEXT
      delete env.VIVID_TEST_DATABASE_URL
      if (database !== undefined) env.VIVID_TEST_DATABASE_URL = database.url
      const result = await logged([process.execPath, ...args], {
        cwd: group.cwd,
        env,
        log: run.log,
      })
      exit += result.exit
      const receipt = readReceipt(report)
      if (receipt.unhandled > 0) throw new Error('proof runner reported an unhandled failure')
      reports.push(receipt)
    } finally {
      await closeDatabase()
      cleanups.delete(closeDatabase)
    }
  }
  return {
    exit,
    tests: reports.flatMap((report) => report.tests),
    unhandled: reports.reduce((total, report) => total + report.unhandled, 0),
  }
}

/** Changed declarations are selected before reversal so a missing import cannot hide a case. */
function candidates(tree, base, files) {
  return files.map((file) => {
    const diff = git(tree, ['diff', '--unified=0', base, 'HEAD', '--', file])
    const source = NodeFS.readFileSync(NodePath.join(tree, file), 'utf8')
    return { file, bodies: leafBodies(testBodies(file, source)), ranges: changedLines(diff) }
  })
}

/** Each changed case must fail itself; another red case cannot lend it proof. */
function fileVerdicts(change, green, red, tree) {
  const { file, bodies, ranges } = change
  const tests = green.tests.filter((test) => test.file === NodePath.join(tree, file))
  const collected = new Set(tests.map((test) => caseBody(test, bodies)))
  const results = tests.flatMap((test) => {
    const body = caseBody(test, bodies)
    if (body === undefined) {
      const changed = ranges.some((range) => test.line >= range.start && test.line <= range.end)
      return changed
        ? [{ state: 'INCONCLUSIVE', label: test.name, reason: 'cannot locate inline test body' }]
        : []
    }
    const changed = ranges.some((range) => range.start <= body.end && range.end >= body.start)
    return changed ? [judgeCase(test, body, red, tree)] : []
  })
  // A conditional declaration that never collects must not disappear behind a proven sibling.
  for (const body of bodies.filter(
    (candidate) => candidate.namedTest && !collected.has(candidate),
  )) {
    if (ranges.some((range) => range.start <= body.end && range.end >= body.start))
      results.push({
        state: 'INCONCLUSIVE',
        label: `${file}:${body.start}`,
        reason: 'changed case did not collect',
      })
  }
  return results.length === 0
    ? [
        {
          state: 'INCONCLUSIVE',
          label: file,
          reason: 'no changed inline case collected (fixture or import change)',
        },
      ]
    : results
}

/** Collection failures stay visible even when another file produced a genuine regression. */
function verdicts(changed, green, red, tree) {
  const results = changed.flatMap((change) => fileVerdicts(change, green, red, tree))
  if (green.exit !== 0 || green.unhandled > 0 || red.unhandled > 0)
    results.push({
      state: 'INCONCLUSIVE',
      label: 'runner',
      reason: 'collection, setup or unhandled failure; see runner output',
    })
  return results
}

/** Only an explicit, nonempty commit trailer can explain an inconclusive proof. */
function exemption(root, base) {
  const messages = git(root, ['log', '--format=%B', `${base}..HEAD`])
  const match = /^Proof-Inconclusive: (?<reason>\S[^\n]*)$/mu.exec(messages)
  return match === null ? undefined : match.groups.reason
}

/** Always discard the clone, even when patch reversal or a runner fails. */
export async function proveBranch(root, selection, environment) {
  const started = Date.now()
  if (!selection.enabled) return { passed: true, results: [], seconds: 0, branch: selection.branch }
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-proof-'))
  const removeTree = () => NodeFS.rmSync(directory, { recursive: true, force: true })
  cleanups.add(removeTree)
  const log = NodePath.join(directory, 'proof.log')
  try {
    const { sha } = snapshot(root, environment, false)
    const tree = scratchTree(root, directory, sha)
    const names = git(tree, [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
      selection.base,
      'HEAD',
    ])
      .split('\0')
      .filter(Boolean)
    const files = names.filter((file) => testPath.test(file))
    const changed = candidates(tree, selection.base, files)
    const code = git(tree, ['diff', '--name-only', '-z', selection.base, 'HEAD'])
      .split('\0')
      .filter((file) => file !== '' && !testPath.test(file))
    const patch =
      code.length === 0
        ? ''
        : git(tree, ['diff', '--binary', selection.base, 'HEAD', '--', ...code])
    // Resolve runners before reversal, which may remove a tracked dependency link.
    const groups = [
      { kind: 'node', cwd: tree, files: files.filter((file) => file.endsWith('.mjs')) },
      ...vitestGroups(
        tree,
        files.filter((file) => !file.endsWith('.mjs')),
      ),
    ].filter((group) => group.files.length > 0)
    const run = { directory, log, env: environment, groups }
    const green = await runTests({ ...run, phase: 'fixed' })
    if (patch !== '') git(tree, ['apply', '--reverse', '--binary', '-'], patch)
    const red = await runTests({ ...run, phase: 'reversed' })
    const results = verdicts(changed, green, red, tree)
    if (files.length === 0)
      results.push({
        state: 'INCONCLUSIVE',
        label: selection.branch,
        reason: 'no added or changed test files',
      })
    const reason = exemption(root, selection.base)
    const passed = results.every(
      (result) =>
        result.state === 'PROVEN' || (result.state === 'INCONCLUSIVE' && reason !== undefined),
    )
    return {
      passed,
      results,
      seconds: (Date.now() - started) / 1000,
      branch: selection.branch,
      reason,
    }
  } catch (error) {
    return {
      passed: false,
      results: [{ state: 'INCONCLUSIVE', label: selection.branch, reason: error.message }],
      seconds: (Date.now() - started) / 1000,
      branch: selection.branch,
    }
  } finally {
    if (NodeFS.existsSync(log)) process.stdout.write(NodeFS.readFileSync(log, 'utf8'))
    removeTree()
    cleanups.delete(removeTree)
  }
}

/** The stage line includes elapsed wall time for clone preparation and both test runs. */
export function formatProof(outcome) {
  if (outcome.results.length === 0) return `proof ${outcome.branch} SKIP (branch is outside fix/)\n`
  const lines = outcome.results.map((result) => `${result.state} ${result.label}: ${result.reason}`)
  if (
    outcome.reason !== undefined &&
    outcome.results.some((result) => result.state === 'INCONCLUSIVE')
  )
    lines.push(`INCONCLUSIVE accepted by commit trailer: ${outcome.reason}`)
  const state = outcome.passed ? 'PASS' : 'FAIL'
  lines.push(`proof ${outcome.branch} ${state} ${outcome.seconds.toFixed(2)}s`)
  return `${lines.join('\n')}\n`
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  stopChildrenOnSignal(async () => {
    for (const cleanup of [...cleanups].toReversed()) await cleanup()
  })
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { base: { type: 'string' }, branch: { type: 'string' }, force: { type: 'boolean' } },
  })
  const root = positionals[0] === undefined ? repositoryRoot : NodePath.resolve(positionals[0])
  const options = {
    only: values.force || process.env.VIVID_PROOF_ENABLED === '1' ? 'proof' : undefined,
    'proof-base': values.base === undefined ? process.env.VIVID_PROOF_BASE : values.base,
    'proof-branch': values.branch === undefined ? process.env.VIVID_PROOF_BRANCH : values.branch,
  }
  const outcome = await proveBranch(root, proofSelection(root, options), process.env)
  process.stdout.write(formatProof(outcome))
  process.exitCode = outcome.passed ? 0 : 1
}

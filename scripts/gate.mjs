#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import { ceilingBase } from './ceilings.mjs'
import { runCloud } from './gate/cloud.mjs'
import { runFocused } from './gate/focused.mjs'
import { runLocal } from './gate/local.mjs'
import { signable, signoff } from './gate/signoff.mjs'
import { stageNames } from './gate/stages.mjs'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

const usage = `usage: pnpm gate [full|affected|focused <test files...>] [options]

  full                 every stage: ${stageNames.join(', ')}
  affected             every stage, but only the test files the change can reach
  focused <files...>   only the named test files, with the test database

  --only <a,b>         full, affected: run only these stages
  --base <commit>      affected: what the change is measured from (default: where the
                       branch left origin/main)
  --ceilings-base <commit>
                       lint: compare ceilings with this fetched commit (default: merge base
                       with origin/main). CI uses the pull request base or pre-push commit.
  --host <ssh host>    run in a warm tree on that machine (default: $VIVID_GATE_HOST)
  --here               run in this checkout even when a host is set
  --name <tree>        the warm tree's name on the host (default: the branch name)
  --committed          gate HEAD as committed, without uncommitted changes
`

/**
 * git exports its repository to a hook: a push from a linked worktree sets GIT_DIR (git 2.54).
 * Every stage finds the repository from its working directory, and the tooling tests make
 * repositories of their own in temporary directories; with GIT_DIR inherited their `git add`
 * wrote fixtures into the pushing worktree's index. The names come from git itself, and they
 * are removed here, in the gate, so the hook, a terminal and a remote run all start the same.
 */
export function withoutRepositoryEnvironment(environment) {
  const names = NodeChildProcess.spawnSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
  })
  const cleaned = { ...environment }
  for (const name of names.stdout.split('\n')) if (name !== '') delete cleaned[name]
  return cleaned
}

/** Split and validate `--only`; an unknown stage is an error, never a silently empty gate. */
export function selectStages(only) {
  if (only === undefined) return stageNames
  const names = only.split(',').map((name) => name.trim())
  const unknown = names.filter((name) => !stageNames.includes(name))
  if (unknown.length > 0)
    throw new Error(`unknown stage ${unknown.join(', ')}; stages are ${stageNames.join(', ')}`)
  return names
}

export function parse(argv) {
  const { values, positionals } = NodeUtil.parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      host: { type: 'string' },
      name: { type: 'string' },
      here: { type: 'boolean', default: false },
      committed: { type: 'boolean', default: false },
      sha: { type: 'string' },
      base: { type: 'string' },
      // The local caller forwards the resolved lint baseline to a ref-less warm tree.
      'ceilings-base': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  })
  const mode = positionals[0] === undefined ? 'full' : positionals[0]
  if (values.help || !['full', 'affected', 'focused'].includes(mode)) return { mode: 'help' }
  return { mode, files: positionals.slice(1), ...values }
}

/** Per-stage times, then one verdict line that names the commit it is about. */
export function report(outcome, label) {
  const lines = outcome.results.map((result) => {
    const state = result.failed.length === 0 ? 'ok  ' : 'FAIL'
    const failures = result.failed.map((failure) => `\n      ${failure}`).join('')
    const log = result.failed.length === 0 ? '' : `\n      log: ${result.log}`
    return `  ${state} ${result.name.padEnd(10)} ${result.seconds.toFixed(1).padStart(6)} s  ${result.detail}${failures}${log}`
  })
  const failed = outcome.results.filter((result) => result.failed.length > 0)
  const counts =
    outcome.counts === undefined
      ? ''
      : ` tests=${outcome.counts.tests} skipped=${outcome.counts.skipped} files=${outcome.counts.files}`
  const verdict = failed.length === 0 ? 'PASS' : `FAIL (${failed.map((r) => r.name).join(', ')})`
  lines.push(
    `gate ${label.mode} ${verdict} sha=${label.sha} run=${outcome.runId} ${outcome.seconds.toFixed(1)}s${counts}`,
  )
  return { text: `${lines.join('\n')}\n`, passed: failed.length === 0 }
}

function lastLines(file) {
  if (!NodeFS.existsSync(file)) return ''
  return NodeFS.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-60).join('\n')
}

/**
 * What an affected run measures the change from: the commit where this branch left the remote
 * default branch, so the change is everything the branch adds, committed or not.
 */
export function changeBase(root, options, environment) {
  if (options.mode !== 'affected') return undefined
  // Always a commit id: a name such as origin/main means nothing in the warm tree's repository,
  // and a name that moves would leave the forwarded argument, and so the task hash, unchanged.
  const args =
    options.base === undefined
      ? ['merge-base', 'HEAD', 'origin/main']
      : ['rev-parse', '--verify', `${options.base}^{commit}`]
  const base = NodeChildProcess.spawnSync('git', args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  })
  if (base.status !== 0)
    throw new Error(
      options.base === undefined
        ? 'affected needs --base: origin/main is not known here'
        : `--base ${options.base} is not a commit here`,
    )
  return base.stdout.trim()
}

/** The commit this checkout is at; a remote run is told the commit it was sent. */
function headLabel(root, options) {
  if (options.sha !== undefined) return options.sha
  const head = NodeChildProcess.spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  })
  const dirty = NodeChildProcess.spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  })
  return `${head.stdout.trim()}${dirty.stdout.trim() === '' ? '' : '+uncommitted'}`
}

/**
 * The gate, then the signoff. A passed full gate of the commit being pushed is told to GitHub
 * (`gate/signoff.mjs`), wherever the stages ran: the status is always posted from this machine,
 * which is the one that pushes and the one signed in to GitHub.
 */
async function main(argv, environment) {
  const options = parse(argv)
  if (options.mode === 'help') {
    process.stdout.write(usage)
    return 2
  }
  const env = withoutRepositoryEnvironment(environment)
  const host = options.host === undefined ? env.VIVID_GATE_HOST : options.host
  const remote = host !== undefined && host !== '' && !options.here
  const ceilingsBase = lintCeilingBase(repositoryRoot, options, env)
  const prepared = { ...options, ceilingsBase }
  const code = remote
    ? runCloud(
        repositoryRoot,
        { ...prepared, host, base: changeBase(repositoryRoot, options, env) },
        env,
      )
    : await runHere(prepared, env)
  if (code === 0 && signable(options))
    process.stdout.write(signoff(repositoryRoot, env, remote ? host : 'the pushing machine'))
  return code
}

/** The lint baseline is independent of affected-test filtering and survives remote transport. */
export function lintCeilingBase(root, options, environment) {
  if (options.mode === 'focused' || !selectStages(options.only).includes('lint')) return undefined
  if (options['ceilings-base'] !== undefined) return options['ceilings-base']
  return ceilingBase(root, environment)
}

/** Every stage in this checkout. */
async function runHere(options, env) {
  const base = changeBase(repositoryRoot, options, env)
  const label = { mode: options.mode, sha: headLabel(repositoryRoot, options) }
  // Here the checks read the working tree. With uncommitted work that is not the commit being
  // pushed, so a fix that exists only on disk could pass the gate for a broken commit.
  if (options.committed && label.sha.endsWith('+uncommitted'))
    throw new Error(
      '--committed with uncommitted work: commit it, or set VIVID_GATE_HOST so the gate runs on the pushed commit in its own tree',
    )
  const outcome =
    options.mode === 'focused'
      ? await runFocused(repositoryRoot, options.files, env)
      : await runLocal(
          repositoryRoot,
          { stages: selectStages(options.only), base, ceilingsBase: options.ceilingsBase },
          env,
        )
  const { text, passed } = report(outcome, label)
  // A remote run's logs are on the remote machine, so a failure brings its evidence with it.
  for (const result of outcome.results.filter((entry) => entry.failed.length > 0))
    process.stdout.write(
      `--- ${result.name} (last lines of ${result.log})\n${lastLines(result.log)}\n`,
    )
  process.stdout.write(text)
  return passed ? 0 : 1
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env)
  } catch (error) {
    process.stderr.write(`gate FAIL: ${error.message}\n`)
    process.exitCode = 1
  }
}

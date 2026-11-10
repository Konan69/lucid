#!/usr/bin/env node
/**
 * The formal check of Vivid's action protocol (the `verify-actions` skill).
 *
 * Two TLA+ models in `models/` describe who may let an Integration act reach the provider
 * (`authority.tla`) and how often the act lands across retries, restarts and reconciliation
 * (`journal.tla`). This script:
 *
 * 1. checks every code anchor in `anchors.json`: each guard a model relies on must still be in
 *    the named function, so a change to that guard fails here and sends the agent to the model;
 * 2. runs the pinned TLC on each model and configuration in `RUNS`, and compares the result with
 *    what the run expects: no violation, or exactly the violation of an open finding.
 *
 * `node check.mjs` runs both and exits non-zero on any difference. `node check.mjs drift` lists
 * the commits since the sync commit in `anchors.json` that touched covered files, for the agent
 * deciding whether the models still describe the code. Java 11 or later must be installed; the
 * TLC release is downloaded once into the user cache and checked against its SHA-256.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

/** TLC 1.7.4 (tla2tools, released 5 August 2024), the newest release not marked pre-release. */
const tlc = {
  version: '1.7.4',
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
  sha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88',
}

/**
 * Each TLC run: a model, constants that override its committed `.cfg`, and the expected result.
 * `finding` names an open finding in SKILL.md whose counterexample this run must still show; when
 * it stops showing, the finding was fixed and the entry must move to `holds`.
 */
const RUNS = [
  { model: 'authority', constants: {}, expect: { holds: true } },
  {
    model: 'journal',
    name: 'journal, Calendar lookup, Executor stops a call when Vivid stops waiting',
    constants: { Lookup: '"calendar"', ExecutorContinues: 'FALSE' },
    expect: { holds: true },
  },
  {
    model: 'journal',
    name: 'journal, Gmail lookup, Executor keeps running after Vivid stops waiting',
    constants: { Lookup: '"mail"', ExecutorContinues: 'TRUE' },
    expect: { holds: true },
  },
  {
    model: 'journal',
    name: 'journal, no lookup, Executor keeps running after Vivid stops waiting',
    constants: { Lookup: '"none"', ExecutorContinues: 'TRUE' },
    expect: { holds: true },
  },
  {
    model: 'journal',
    name: 'journal, Calendar lookup, Executor keeps running after Vivid stops waiting',
    constants: { Lookup: '"calendar"', ExecutorContinues: 'TRUE' },
    expect: { finding: 'F1', violated: 'NotAppliedIsTrue' },
  },
]

/** Whitespace-insensitive text, so formatting alone never trips an anchor. */
const flat = (text) => text.replace(/\s+/g, ' ')

/** The source of one top-level declaration: from its `const`/`function` line to the next one. */
function declaration(source, symbol) {
  const start = new RegExp(
    `^(?:export )?(?:const ${symbol}\\b|function ${symbol}\\b)`,
    'm',
  ).exec(source)
  if (start === null) return null
  const rest = source.slice(start.index + 1)
  const next = /^(?:export |const |function |type |interface |class |\/\*\*)/m.exec(rest)
  return source.slice(start.index, next === null ? source.length : start.index + 1 + next.index)
}

/** Every anchor's snippets must be inside its declaration. Returns the failures, in words. */
function checkAnchors(anchors) {
  const failures = []
  for (const anchor of anchors) {
    const path = join(root, anchor.file)
    if (!existsSync(path)) {
      failures.push(`${anchor.file} is gone (${anchor.model})`)
      continue
    }
    const body = declaration(readFileSync(path, 'utf8'), anchor.symbol)
    if (body === null) {
      failures.push(`${anchor.file}: ${anchor.symbol} is gone (${anchor.model})`)
      continue
    }
    for (const snippet of anchor.snippets)
      if (!flat(body).includes(flat(snippet)))
        failures.push(`${anchor.file}: ${anchor.symbol} no longer has \`${snippet}\` (${anchor.model})`)
  }
  return failures
}

/** A Java 11+ runtime: JAVA_HOME, then PATH, then the usual Linux install directory. */
function java() {
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', 'java'))
  candidates.push('java')
  if (existsSync('/usr/lib/jvm'))
    for (const entry of readdirSync('/usr/lib/jvm').sort().reverse())
      candidates.push(join('/usr/lib/jvm', entry, 'bin', 'java'))
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  throw new Error('No Java runtime found. Install a JRE 11 or later (e.g. openjdk-17-jre-headless).')
}

/** The pinned tla2tools.jar, downloaded once and verified by SHA-256 on every run. */
function tlcJar() {
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'vivid-formal')
  const jar = join(cache, `tla2tools-${tlc.version}.jar`)
  if (!existsSync(jar)) {
    mkdirSync(cache, { recursive: true })
    const fetched = spawnSync('curl', ['-fsSL', '-o', jar, tlc.url], { stdio: 'inherit' })
    if (fetched.status !== 0) throw new Error(`Could not download ${tlc.url}`)
  }
  const digest = createHash('sha256').update(readFileSync(jar)).digest('hex')
  if (digest !== tlc.sha256) {
    rmSync(jar)
    throw new Error(`${jar} has SHA-256 ${digest}, expected ${tlc.sha256}; it was removed.`)
  }
  return jar
}

/** The committed config with this run's constants replaced. */
function configFor(run) {
  let config = readFileSync(join(here, 'models', `${run.model}.cfg`), 'utf8')
  for (const [name, value] of Object.entries(run.constants)) {
    const line = new RegExp(`^(\\s*${name}\\s*=).*$`, 'm')
    if (!line.test(config)) throw new Error(`${run.model}.cfg has no constant ${name}`)
    config = config.replace(line, `$1 ${value}`)
  }
  return config
}

/** Runs TLC once; the result is `holds`, a violated invariant, or an error with TLC's output. */
function check(javaPath, jar, run, scratch) {
  const dir = mkdtempSync(join(scratch, `${run.model}-`))
  writeFileSync(join(dir, `${run.model}.tla`), readFileSync(join(here, 'models', `${run.model}.tla`)))
  writeFileSync(join(dir, `${run.model}.cfg`), configFor(run))
  const started = Date.now()
  const result = spawnSync(
    javaPath,
    [
      '-XX:+UseParallelGC',
      '-cp',
      jar,
      'tlc2.TLC',
      '-workers',
      'auto',
      '-metadir',
      join(dir, 'states'),
      '-config',
      `${run.model}.cfg`,
      `${run.model}.tla`,
    ],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const output = `${result.stdout}${result.stderr}`
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const states = /([\d,]+) distinct states found/.exec(output)?.[1] ?? '?'
  const violated = /Invariant (\w+) is violated/.exec(output)?.[1]
  if (violated !== undefined) return { violated, output, seconds, states }
  if (output.includes('Model checking completed. No error has been found.'))
    return { holds: true, output, seconds, states }
  return { error: true, output, seconds, states }
}

function runAll() {
  const anchors = JSON.parse(readFileSync(join(here, 'anchors.json'), 'utf8')).anchors
  const failures = checkAnchors(anchors).map(
    (line) => `anchor: ${line}. Re-read the code, update the model and anchors.json together.`,
  )
  const javaPath = java()
  const jar = tlcJar()
  const scratch = mkdtempSync(join(tmpdir(), 'vivid-formal-'))
  try {
    for (const run of RUNS) {
      const name = run.name ?? run.model
      const result = check(javaPath, jar, run, scratch)
      const said = result.holds
        ? 'holds'
        : result.violated !== undefined
          ? `violates ${result.violated}`
          : 'TLC error'
      console.log(`${name}: ${said} (${result.states} states, ${result.seconds}s)`)
      const expected = run.expect.holds
        ? result.holds === true
        : result.violated === run.expect.violated
      if (expected) continue
      if (run.expect.finding !== undefined && result.holds)
        failures.push(
          `${name}: finding ${run.expect.finding} no longer reproduces. If the code fixed it, ` +
            'move this run to `holds` and close the finding in SKILL.md.',
        )
      else failures.push(`${name}: expected ${run.expect.holds ? 'no violation' : `violation of ${run.expect.violated}`}, got ${said}.\n${result.output}`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`verify-actions: ${failure}`)
    console.error('Read a counterexample with the /statechart skill (SKILL.md, "Reading a result").')
    process.exit(1)
  }
  console.log(`verify-actions: ${anchors.length} anchors present; models as expected.`)
}

/** Commits since the sync commit that touched a covered file. */
function drift() {
  const { sync, anchors } = JSON.parse(readFileSync(join(here, 'anchors.json'), 'utf8'))
  const files = [...new Set(anchors.map((anchor) => anchor.file))]
  const log = spawnSync('git', ['log', '--oneline', `${sync}..HEAD`, '--', ...files], {
    cwd: root,
    encoding: 'utf8',
  })
  if (log.status !== 0) throw new Error(log.stderr)
  console.log(log.stdout.trim() === '' ? `No covered file changed since ${sync}.` : log.stdout.trim())
}

if (process.argv[2] === 'drift') drift()
else runAll()

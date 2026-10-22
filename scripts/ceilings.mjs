#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { parseSync } from 'oxc-parser'
import { countFindings } from './gate/ratchets.mjs'

const tablePath = 'scripts/gate/ratchets.mjs'
const hookPath = '.husky/pre-push'
const Ceiling = Schema.Struct({
  plugin: Schema.NonEmptyString,
  rule: Schema.NonEmptyString,
  ceiling: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const isLiteral = Schema.is(Schema.Union([Schema.String, Schema.Number]))
const decodeCeiling = Schema.decodeUnknownResult(Ceiling)

/** Git failures must not look like an empty baseline and silently permit every raise. */
function git(root, args, environment = process.env) {
  const result = NodeChildProcess.spawnSync('git', args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`ceilings: git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** Shallow CI and ref-less warm trees need the caller to fetch and pass a comparison commit. */
export function ceilingBase(root, environment) {
  const base = NodeChildProcess.spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  })
  if (base.status !== 0)
    throw new Error(
      `ceilings: cannot resolve the merge base with origin/main; fetch a comparison commit and pass --ceilings-base <commit> to the gate: ${base.stderr.trim()}`,
    )
  return base.stdout.trim()
}

/** Decode source literals once, and reject duplicate identities rather than hiding a raise. */
function ceilingMap(entries) {
  const found = new Map()
  for (const entry of entries) {
    const decoded = decodeCeiling(entry)
    if (Result.isFailure(decoded))
      throw new Error(`ceilings: invalid declaration: ${String(decoded.failure)}`)
    const value = decoded.success
    const rule = `${value.plugin}/${value.rule}`
    if (found.has(rule)) throw new Error(`ceilings: duplicate rule ${rule}`)
    found.set(rule, value.ceiling)
  }
  if (found.size === 0) throw new Error('ceilings: no ceiling declarations found')
  return found
}

/** Only literal fields are legal in the ceiling table, so checking never executes historical code. */
function literalField(property) {
  if (property.type !== 'Property' || property.computed || property.method || property.shorthand)
    throw new Error('ceilings: expected a literal property')
  const name = property.key.name ?? property.key.value
  const value = property.value
  if (value.type === 'Literal' && isLiteral(value.value)) return [String(name), value.value]
  throw new Error(`ceilings: expected a literal value for ${name}`)
}

function tableCeilings(source) {
  const parsed = parseSync(tablePath, source)
  if (parsed.errors.length > 0) throw new Error(`ceilings: cannot parse ${tablePath}`)
  const declarations = parsed.program.body
    .map((statement) =>
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement,
    )
    .filter((statement) => statement !== null && statement.type === 'VariableDeclaration')
    .flatMap((statement) => statement.declarations)
    .filter(
      (declaration) => declaration.id.type === 'Identifier' && declaration.id.name === 'ratchets',
    )
  if (declarations.length !== 1) throw new Error('ceilings: expected one ratchets declaration')
  const array = declarations[0].init
  if (array === null || array.type !== 'ArrayExpression')
    throw new Error('ceilings: ratchets must be a literal array')
  return ceilingMap(
    array.elements.map((entry) => {
      if (entry === null || entry.type !== 'ObjectExpression')
        throw new Error('ceilings: expected a literal entry')
      return Object.fromEntries(entry.properties.map(literalField))
    }),
  )
}

/** The pre-gate hook is read only for historical proofs, before the table existed. */
function hookCeilings(source) {
  const declarations = source.matchAll(/^check_ratchet "[^"]*" "([^"]+)" "([^"]+)" (\d+)\s*$/gmu)
  return ceilingMap(
    Array.from(declarations, (match) => ({
      plugin: match[1],
      rule: match[2],
      ceiling: Number(match[3]),
    })),
  )
}

/** A missing table is legitimate only in the historical hook layout. Missing revisions fail. */
export function readCeilings(root, revision, environment) {
  const files = git(
    root,
    ['ls-tree', '-r', '--name-only', revision, '--', tablePath, hookPath],
    environment,
  ).split('\n')
  if (files.includes(tablePath))
    return tableCeilings(git(root, ['show', `${revision}:${tablePath}`], environment))
  if (files.includes(hookPath))
    return hookCeilings(git(root, ['show', `${revision}:${hookPath}`], environment))
  throw new Error(`ceilings: ${revision} contains neither ${tablePath} nor the historical hook`)
}

/** New rules may set their initial baseline. Every existing identity may only hold or fall. */
export function raisedCeilings(before, after) {
  const failures = []
  for (const [rule, ceiling] of after) {
    const old = before.get(rule)
    if (old !== undefined && ceiling > old)
      failures.push(
        `${rule}: ceiling ${old} -> ${ceiling}. A ceiling only goes down (${tablePath}).`,
      )
  }
  return failures
}

/** Read the table from disk so a local gate catches uncommitted ceiling edits. */
export function workingCeilings(root) {
  return tableCeilings(NodeFS.readFileSync(NodePath.join(root, tablePath), 'utf8'))
}

/** The working tree matters for local gates and the CLI, including an uncommitted raise. */
export function checkRaises(root, base, environment) {
  return raisedCeilings(readCeilings(root, base, environment), workingCeilings(root))
}

/** The CLI measures an existing log. The gate supplies these same fields from checkRatchets. */
export function measureCeilings(output, ceilings) {
  return Array.from(ceilings, ([identity, ceiling]) => {
    const slash = identity.lastIndexOf('/')
    const plugin = identity.slice(0, slash)
    const rule = identity.slice(slash + 1)
    return { plugin, rule, ceiling, count: countFindings(output, { plugin, rule }) }
  })
}

/** Tightening consumes measured counts, so cached and fresh lint need no second linter run. */
export function checkTightCeilings(measurements) {
  const failures = []
  for (const measurement of measurements) {
    if (measurement.count < measurement.ceiling)
      failures.push(
        `${measurement.plugin}/${measurement.rule}: ${measurement.count} findings below ceiling ${measurement.ceiling}; write ceiling: ${measurement.count} in ${tablePath}.`,
      )
  }
  return failures
}

/** Explicit revisions support historical replays; normal use checks the tree against its merge base. */
export function runCeilings(root, argv) {
  const { values, positionals } = NodeUtil.parseArgs({
    args: argv,
    allowPositionals: true,
    options: { lint: { type: 'string' } },
  })
  if (positionals.length > 2)
    throw new Error('usage: node scripts/ceilings.mjs [base [head]] [--lint log]')
  const base = positionals[0] === undefined ? ceilingBase(root) : positionals[0]
  const head = positionals[1]
  const failures =
    head === undefined
      ? checkRaises(root, base)
      : raisedCeilings(readCeilings(root, base), readCeilings(root, head))
  if (values.lint !== undefined) {
    failures.push(
      ...checkTightCeilings(
        measureCeilings(
          NodeFS.readFileSync(values.lint, 'utf8'),
          head === undefined ? workingCeilings(root) : readCeilings(root, head),
        ),
      ),
    )
  }
  return failures
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const failures = runCeilings(process.cwd(), process.argv.slice(2))
    for (const failure of failures) process.stderr.write(`${failure}\n`)
    process.stdout.write(`ceilings: ${failures.length} violations\n`)
    process.exitCode = failures.length === 0 ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

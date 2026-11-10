#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { isStringLiteral, parseSource, sourcePositions, walk } from './syntax.mjs'
import * as NodeURL from 'node:url'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const allowlistPath = NodePath.join(repositoryRoot, 'scripts', 'effect-boundary-allowlist.json')
const AllowlistEntry = Schema.Struct({
  file: Schema.String,
  symbol: Schema.optionalKey(Schema.String),
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
  classification: Schema.String,
})
const Allowlist = Schema.Array(AllowlistEntry)
const decodeAllowlist = Schema.decodeUnknownResult(Allowlist)
const decodeAllowlistJson = Schema.decodeUnknownSync(Schema.fromJsonString(Allowlist))
const wildcard = /[*?{}[\]]/u
const promiseOperationKinds = new Map([
  ['all', 'promise-all'],
  ['allSettled', 'promise-all-settled'],
])
const effectOperationKinds = new Map([
  ['runPromise', 'effect-run-promise'],
  ['runPromiseExit', 'effect-run-promise'],
  // The `With` forms take a Context first and start the Effect the same way.
  ['runPromiseWith', 'effect-run-promise'],
  ['runPromiseExitWith', 'effect-run-promise'],
  ['tryPromise', 'effect-try-promise'],
  ['promise', 'effect-promise-adapter'],
  ['async', 'effect-async-adapter'],
])

/** Production TypeScript only; tests, declarations, generated files, and migration state are separate gates. */
function isProductionTypeScript(relativePath) {
  if (!/\.[cm]?tsx?$/u.test(relativePath)) return false
  if (/(?:^|[/\\])(?:node_modules|dist|build|drizzle)(?:[/\\]|$)/u.test(relativePath)) return false
  if (/(?:\.test|\.spec|\.gen|worker-test-entry)\.[cm]?tsx?$/u.test(relativePath)) return false
  if (/\.d\.[cm]?ts$/u.test(relativePath)) return false
  return (
    relativePath.startsWith('apps/server/src/') ||
    relativePath.startsWith('apps/cells/src/') ||
    // `packages/<name>/src/` or, inside a group directory, `packages/<group>/<name>/src/`.
    /^packages\/[^/]+(?:\/[^/]+)?\/src\//u.test(relativePath)
  )
}

/** List files deterministically so reports and allowlist checks are stable across machines. */
function productionFiles(root = repositoryRoot) {
  const roots = [
    NodePath.join(root, 'apps', 'server', 'src'),
    NodePath.join(root, 'apps', 'cells', 'src'),
  ]
  const packagesRoot = NodePath.join(root, 'packages')
  // A package is `packages/<name>` or, inside a group directory, `packages/<group>/<name>`.
  for (const entry of NodeFS.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = NodePath.join(packagesRoot, entry.name)
    roots.push(NodePath.join(directory, 'src'))
    for (const child of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (child.isDirectory()) roots.push(NodePath.join(directory, child.name, 'src'))
    }
  }
  const files = []
  const visit = (directory) => {
    let entries
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = NodePath.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else {
        const relative = NodePath.relative(root, absolute).split(NodePath.sep).join('/')
        if (isProductionTypeScript(relative)) files.push(relative)
      }
    }
  }
  for (const rootPath of roots) visit(rootPath)
  return files.toSorted((left, right) => left.localeCompare(right))
}

const propertyName = (node) => {
  if (node.type !== 'MemberExpression') return undefined
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && isStringLiteral(node.property)) return node.property.value
  return undefined
}

const expressionOwner = (node) =>
  propertyName(node) !== undefined && node.object.type === 'Identifier'
    ? node.object.name
    : undefined

const functions = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
  'TSDeclareFunction',
  'TSFunctionType',
  'TSConstructorType',
  'TSMethodSignature',
  'TSIndexSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
])
const methods = new Set(['MethodDefinition', 'TSAbstractMethodDefinition'])
const properties = new Set(['Property', ...methods])

function isMethod(node) {
  if (node === undefined) return false
  return (
    methods.has(node.type) || (node.type === 'Property' && (node.method || node.kind !== 'init'))
  )
}

function isFunction(node) {
  return functions.has(node.type) || isMethod(node)
}

function identifierName(node) {
  if (node === null || node === undefined) return undefined
  return node.type === 'Identifier' ? node.name : undefined
}

function keyName(node) {
  if (node.computed) return undefined
  if (node.key.type === 'Identifier') return node.key.name
  if (node.key.type === 'PrivateIdentifier') return `#${node.key.name}`
  return node.type === 'Property' && !isMethod(node) && isStringLiteral(node.key)
    ? node.key.value
    : undefined
}

function routeName(node) {
  const route = node.arguments.find(isStringLiteral)
  const operation = propertyName(node.callee)
  return route !== undefined && operation !== undefined ? `${operation}:${route.value}` : undefined
}

function declaredFunctionName(node, parents) {
  const name = identifierName(node.id)
  if (name !== undefined) return name
  const parent = parents.get(node)
  if (parent === undefined) return undefined
  if (parent.type === 'VariableDeclarator') return identifierName(parent.id)
  if (properties.has(parent.type)) return keyName(parent)
  if (isMethod(node) || node.type === 'TSMethodSignature') return keyName(node)
  return parent.type === 'CallExpression' ? routeName(parent) : undefined
}

function owningSymbol(node, parents) {
  let current = node
  let moduleBinding
  while (current !== undefined) {
    if (current.type === 'VariableDeclarator' && current.id.type === 'Identifier')
      moduleBinding = current.id.name
    if (isFunction(current)) {
      const name = declaredFunctionName(current, parents)
      if (name !== undefined) return name
    }
    if (current.type === 'ClassDeclaration' && current.id !== null) return current.id.name
    current = parents.get(current)
  }
  return moduleBinding ?? '<module>'
}

function promiseReturn(node) {
  const annotation = node.returnType ?? node.typeAnnotation
  if (annotation === null || annotation === undefined) return false
  const result = annotation.typeAnnotation
  return result.type === 'TSTypeReference' && identifierName(result.typeName) === 'Promise'
}

function functionBoundaryKinds(node, parents) {
  if (!isFunction(node) || isMethod(parents.get(node))) return []
  const value = isMethod(node) ? node.value : node
  const kinds = []
  if (value.async) kinds.push('async-function')
  if (promiseReturn(value)) kinds.push('promise-return')
  return kinds
}

function callBoundaryKinds(node) {
  if (node.type !== 'CallExpression') return []
  const owner = expressionOwner(node.callee)
  const operation = propertyName(node.callee)
  const promiseKind = owner === 'Promise' ? promiseOperationKinds.get(operation) : undefined
  if (promiseKind !== undefined) return [promiseKind]
  if (identifierName(node.callee) === 'fetch' || (owner === 'globalThis' && operation === 'fetch'))
    return ['raw-fetch']
  const effectKind = owner === 'Effect' ? effectOperationKinds.get(operation) : undefined
  return effectKind === undefined ? [] : [effectKind]
}

function syntaxBoundaryKinds(node) {
  if (node.type === 'AwaitExpression') return ['await']
  if (node.type === 'TryStatement' && node.handler !== null) return ['try-catch']
  if (node.type === 'NewExpression' && identifierName(node.callee) === 'Promise')
    return ['promise-constructor']
  return []
}

function findingPosition(node, parent, position) {
  const declaration = ['FunctionDeclaration', 'TSDeclareFunction'].includes(node.type)
  const exported =
    parent !== undefined &&
    ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(parent.type)
  return position(declaration && exported ? parent.start : node.start)
}

export function scanSource(file, source) {
  const tree = parseSource(file, source)
  const position = sourcePositions(source)
  const parents = new WeakMap()
  const findings = []
  walk(tree, (node, parent) => {
    if (parent !== undefined) parents.set(node, parent)
    const imported =
      node.type === 'ImportDeclaration' && node.source.value === 'better-result'
        ? ['better-result-import']
        : []
    for (const kind of [
      ...imported,
      ...functionBoundaryKinds(node, parents),
      ...syntaxBoundaryKinds(node),
      ...callBoundaryKinds(node),
    ]) {
      const location = findingPosition(node, parent, position)
      findings.push({
        file,
        symbol: owningSymbol(node, parents),
        kind,
        line: location.line,
        column: location.column,
      })
    }
  })
  return findings
}

const entryKey = ({ file, symbol }) => `${file}\u0000${symbol}`

/** Exact file+symbol allowlists fail on duplicates, wildcards, and stale classifications. */
function validateAllowlist(entries, findings) {
  const decoded = decodeAllowlist(entries)
  if (Result.isFailure(decoded)) {
    throw new Error('Every allowlist entry requires file, symbol(s), and classification strings')
  }
  const findingKeys = new Set(findings.map(entryKey))
  const allowed = new Set()
  for (const entry of decoded.success) {
    const symbols = entry.symbol === undefined ? entry.symbols : [entry.symbol]
    if (symbols === undefined || entry.classification.length === 0) {
      throw new Error('Every allowlist entry requires file, symbol(s), and classification strings')
    }
    for (const symbol of symbols) {
      if (wildcard.test(entry.file) || wildcard.test(symbol)) {
        throw new Error(`Allowlist wildcards are forbidden: ${entry.file}#${symbol}`)
      }
      const key = entryKey({ file: entry.file, symbol })
      if (allowed.has(key)) throw new Error(`Duplicate allowlist entry: ${entry.file}#${symbol}`)
      if (!findingKeys.has(key)) throw new Error(`Stale allowlist entry: ${entry.file}#${symbol}`)
      allowed.add(key)
    }
  }
  return allowed
}

/** Build a deterministic machine-readable report for migration planning and CI enforcement. */
function buildReport(mode, files, findings, allowed) {
  const ordered = findings.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.kind.localeCompare(right.kind),
  )
  const counts = {}
  for (const finding of ordered) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1
  const unallowlisted = ordered.filter((finding) => !allowed.has(entryKey(finding)))
  return {
    mode,
    filesScanned: files.length,
    totalFindings: ordered.length,
    unallowlistedFindings: unallowlisted.length,
    counts,
    findings: ordered.map((finding) => ({
      file: finding.file,
      symbol: finding.symbol,
      kind: finding.kind,
      line: finding.line,
      column: finding.column,
      allowed: allowed.has(entryKey(finding)),
    })),
  }
}

function formatSummary(report) {
  return `Effect boundary audit: ${report.filesScanned} files; ${report.totalFindings} findings; ${report.unallowlistedFindings} unallowlisted`
}

function main() {
  const mode = process.argv[2]
  if (mode !== 'report' && mode !== 'enforce') {
    process.stderr.write('usage: effect-boundary-audit.mjs <report|enforce>\n')
    process.exitCode = 2
    return
  }
  const files = productionFiles()
  const findings = files.flatMap((file) =>
    scanSource(file, NodeFS.readFileSync(NodePath.join(repositoryRoot, file), 'utf8')),
  )
  const entries = decodeAllowlistJson(NodeFS.readFileSync(allowlistPath, 'utf8'))
  const allowed = validateAllowlist(entries, findings)
  const report = buildReport(mode, files, findings, allowed)
  if (mode === 'report') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${formatSummary(report)}\n`)
  if (mode === 'enforce' && report.unallowlistedFindings > 0) {
    const offenders = report.findings
      .filter((finding) => !finding.allowed)
      .map(
        (finding) =>
          `  ${finding.file}:${finding.line}:${finding.column} ${finding.symbol} [${finding.kind}]`,
      )
    process.stderr.write(`${offenders.join('\n')}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
)
  main()

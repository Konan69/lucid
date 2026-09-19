#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowlistPath = path.join(repositoryRoot, 'scripts', 'effect-boundary-allowlist.json')
const wildcard = /[*?{}[\]]/u

/** Production TypeScript only; tests, declarations, generated files, and migration state are separate gates. */
export function isProductionTypeScript(relativePath) {
  if (!/\.[cm]?tsx?$/u.test(relativePath)) return false
  if (/(?:^|[/\\])(?:node_modules|dist|build|drizzle)(?:[/\\]|$)/u.test(relativePath)) return false
  if (/(?:\.test|\.spec|\.gen|worker-test-entry)\.[cm]?tsx?$/u.test(relativePath)) return false
  if (/\.d\.[cm]?ts$/u.test(relativePath)) return false
  return relativePath.startsWith('apps/server/src/') || /^packages\/[^/]+\/src\//u.test(relativePath)
}

/** List files deterministically so reports and allowlist checks are stable across machines. */
export function productionFiles(root = repositoryRoot) {
  const roots = [path.join(root, 'apps', 'server', 'src')]
  const packagesRoot = path.join(root, 'packages')
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(path.join(packagesRoot, entry.name, 'src'))
  }
  const files = []
  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else {
        const relative = path.relative(root, absolute).split(path.sep).join('/')
        if (isProductionTypeScript(relative)) files.push(relative)
      }
    }
  }
  for (const rootPath of roots) visit(rootPath)
  return files.sort((left, right) => left.localeCompare(right))
}

const propertyName = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

const expressionOwner = (node) => {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return node.expression.text
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.expression.text
  }
  return undefined
}

const declaredFunctionName = (node) => {
  if (node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (
    ts.isPropertyAssignment(parent) &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
  ) {
    return parent.name.text
  }
  if (ts.isCallExpression(parent)) {
    const route = parent.arguments.find(ts.isStringLiteral)?.text
    const operation = propertyName(parent.expression)
    if (route !== undefined && operation !== undefined) return `${operation}:${route}`
  }
  return undefined
}

/** Find the nearest stable function, method, route, or class used by exact allowlist entries. */
function owningSymbol(node) {
  let current = node
  let moduleBinding
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      moduleBinding = current.name.text
    }
    if (ts.isFunctionLike(current)) {
      const name = declaredFunctionName(current)
      if (name !== undefined) return name
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor'
    if (ts.isClassDeclaration(current) && current.name !== undefined) return current.name.text
    current = current.parent
  }
  return moduleBinding ?? '<module>'
}

/** Inventory raw async and Effect runtime boundaries in one source file. */
export function scanSource(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  const add = (kind, node) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    findings.push({
      file,
      symbol: owningSymbol(node),
      kind,
      line: position.line + 1,
      column: position.character + 1,
    })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === 'better-result') add('better-result-import', node)
    }
    if (ts.isFunctionLike(node)) {
      if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        add('async-function', node)
      }
      if (
        node.type !== undefined &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === 'Promise'
      ) {
        add('promise-return', node)
      }
    }
    if (ts.isAwaitExpression(node)) add('await', node)
    if (ts.isTryStatement(node) && node.catchClause !== undefined) add('try-catch', node.catchClause)
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Promise') {
      add('promise-constructor', node)
    }
    if (ts.isCallExpression(node)) {
      const owner = expressionOwner(node.expression)
      const operation = propertyName(node.expression)
      if (owner === 'Promise' && operation === 'all') add('promise-all', node)
      if (owner === 'Promise' && operation === 'allSettled') add('promise-all-settled', node)
      if (
        (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') ||
        (owner === 'globalThis' && operation === 'fetch')
      ) {
        add('raw-fetch', node)
      }
      if (owner === 'Effect') {
        if (operation === 'runPromise' || operation === 'runPromiseExit') add('effect-run-promise', node)
        if (operation === 'tryPromise') add('effect-try-promise', node)
        if (operation === 'promise') add('effect-promise-adapter', node)
        if (operation === 'async') add('effect-async-adapter', node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}

const entryKey = ({ file, symbol }) => `${file}\u0000${symbol}`

/** Exact file+symbol allowlists fail on duplicates, wildcards, and stale classifications. */
export function validateAllowlist(entries, findings) {
  const findingKeys = new Set(findings.map(entryKey))
  const allowed = new Set()
  for (const entry of entries) {
    const symbols = typeof entry.symbol === 'string' ? [entry.symbol] : entry.symbols
    if (
      typeof entry.file !== 'string' ||
      !Array.isArray(symbols) ||
      symbols.some((symbol) => typeof symbol !== 'string') ||
      typeof entry.classification !== 'string' ||
      entry.classification.length === 0
    ) {
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
export function buildReport(mode, files, findings, allowed) {
  const ordered = [...findings].sort(
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
      ...finding,
      allowed: allowed.has(entryKey(finding)),
    })),
  }
}

export function formatSummary(report) {
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
    scanSource(file, readFileSync(path.join(repositoryRoot, file), 'utf8')),
  )
  const entries = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  const allowed = validateAllowlist(entries, findings)
  const report = buildReport(mode, files, findings, allowed)
  if (mode === 'report') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${formatSummary(report)}\n`)
  if (mode === 'enforce' && report.unallowlistedFindings > 0) {
    const offenders = report.findings
      .filter((finding) => !finding.allowed)
      .map((finding) => `  ${finding.file}:${finding.line}:${finding.column} ${finding.symbol} [${finding.kind}]`)
    process.stderr.write(`${offenders.join('\n')}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

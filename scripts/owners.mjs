#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import ts from 'typescript'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const serverRoot = 'apps/server/src/'
const writes = new Set(['insert', 'update', 'delete', 'upsert'])
// These modules construct disposable test data, never application records.
const fixtures = new Set(['library/fixtures.ts', 'runtime/chains.ts'])

/** Production writers alone define this boundary; test setup may populate several domains. */
function isWriter(file) {
  const relative = file.slice(serverRoot.length)
  return !(
    /(?:^|\/)(?:tests|__fixtures__)\//u.test(relative) ||
    /(?:\.test|\.spec|\.d)\.ts$/u.test(relative) ||
    /(?:^|\/)(?:testing|testdb|proof)\.ts$/u.test(relative) ||
    fixtures.has(relative)
  )
}

/** A symbol can be imported under another name or re-exported by the database schema. */
function symbolOf(checker, expression) {
  const symbol = checker.getSymbolAtLocation(expression)
  if (symbol === undefined) return undefined
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

/** Both dot and literal bracket calls name the same mutation in JavaScript. */
function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text
  }
  return undefined
}

/** Resolve the Drizzle factory's import too, so a renamed factory still declares an owned table. */
function isTableFactory(checker, expression) {
  const target = ts.isPropertyAccessExpression(expression) ? expression.expression : expression
  const symbol = checker.getSymbolAtLocation(target)
  if (symbol === undefined || symbol.declarations === undefined) return false
  for (const declaration of symbol.declarations) {
    const imported = ts.isImportSpecifier(declaration)
      ? (declaration.propertyName ?? declaration.name).text
      : propertyName(expression)
    const module = ts.findAncestor(declaration, ts.isImportDeclaration)
    if (
      module !== undefined &&
      module.moduleSpecifier.text === 'drizzle-orm/pg-core' &&
      imported === 'pgTable'
    )
      return true
  }
  return false
}

/** Follow local aliases as well as imports so renaming a table cannot evade ownership. */
function tableOf(checker, expression, tables, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return tableOf(checker, expression.expression, tables, seen)
  }
  const symbol = symbolOf(checker, expression)
  if (symbol === undefined || seen.has(symbol)) return undefined
  const table = tables.get(symbol)
  if (table !== undefined) return table
  seen.add(symbol)
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return tableOf(checker, declaration.initializer, tables, seen)
    }
  }
  return undefined
}

/** Table declarations, rather than a hand-maintained table list, identify each owning domain. */
function declaredTables(program, checker) {
  const tables = new Map()
  for (const source of program.getSourceFiles()) {
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        isTableFactory(checker, node.initializer.expression)
      ) {
        const domain = source.fileName.slice(serverRoot.length).split('/')[0]
        tables.set(checker.getSymbolAtLocation(node.name), { domain, name: node.name.text })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return tables
}

/**
 * Inspect syntax and resolved local symbols without loading SDKs or a TypeScript type graph.
 * Reads, joins, and membership checks are legal. Only mutation targets cross this boundary.
 * Sources are repository-relative paths mapped to text, also usable for historical replays.
 */
export function checkOwners(sources) {
  const host = ts.createCompilerHost({})
  host.getSourceFile = (file, languageVersion) => {
    const source = sources.get(file)
    return source === undefined
      ? undefined
      : ts.createSourceFile(file, source, languageVersion, true)
  }
  host.fileExists = (file) => sources.has(file)
  host.readFile = (file) => sources.get(file)
  host.getCurrentDirectory = () => ''
  const program = ts.createProgram(
    [...sources.keys()],
    {
      noResolve: true,
      noLib: true,
      types: [],
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    host,
  )
  const checker = program.getTypeChecker()
  const tables = declaredTables(program, checker)
  const findings = []
  for (const source of program.getSourceFiles()) {
    if (!isWriter(source.fileName)) continue
    const domain = source.fileName.slice(serverRoot.length).split('/')[0]
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        writes.has(propertyName(node.expression)) &&
        node.arguments.length > 0
      ) {
        const table = tableOf(checker, node.arguments[0], tables)
        if (table !== undefined && table.domain !== domain) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          findings.push({
            file: source.fileName,
            line: line + 1,
            operation: propertyName(node.expression),
            table: table.name,
            owner: table.domain,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return findings
}

/** Git supplies immutable past source for the same policy used on the working tree. */
function git(root, args) {
  return NodeChildProcess.execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

/** Read only server source; no database, runtime state, or application configuration is opened. */
function sourcesAt(root, ref) {
  const files =
    ref === undefined
      ? NodeFS.readdirSync(NodePath.join(root, serverRoot), { recursive: true }).map(
          (file) => `${serverRoot}${file}`,
        )
      : git(root, ['ls-tree', '-r', '--name-only', ref, '--', serverRoot]).trim().split('\n')
  return new Map(
    files
      .filter((file) => file.endsWith('.ts'))
      .toSorted()
      .map((file) => [
        file,
        ref === undefined
          ? NodeFS.readFileSync(NodePath.join(root, file), 'utf8')
          : git(root, ['show', `${ref}:${file}`]),
      ]),
  )
}

/** The CLI fails with actionable owner diagnostics, including when replaying a past commit. */
export function main(args) {
  const { values } = NodeUtil.parseArgs({
    args,
    options: { root: { type: 'string' }, ref: { type: 'string' } },
  })
  const root = values.root === undefined ? repositoryRoot : NodePath.resolve(values.root)
  const findings = checkOwners(sourcesAt(root, values.ref))
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}: ${finding.operation}(${finding.table}) belongs to ${finding.owner}; call its owning service\n`,
    )
  }
  if (findings.length > 0) return 1
  process.stdout.write('owners PASS: every server table write stays in its owning domain\n')
  return 0
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2))
}

#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import * as ts from 'tsc-rs/unstable/ast'
import { API, SymbolFlags, ModuleKind, ModuleResolutionKind } from 'tsc-rs/unstable/sync'
import { createFileSystem } from 'tsc-rs/unstable/fs'
import { libraryDirectory } from './native.mjs'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const serverRoot = 'apps/server/src/'
// Standard collection signatures distinguish Map/Set.delete from Drizzle without loading SDKs.
const libraries = new Map(
  [
    'lib.es5.d.ts',
    'lib.es2015.collection.d.ts',
    'lib.es2015.iterable.d.ts',
    'lib.es2015.symbol.d.ts',
    'lib.es2015.symbol.wellknown.d.ts',
  ].map((file) => [
    `/typescript/${file}`,
    NodeFS.readFileSync(NodePath.join(libraryDirectory, file), 'utf8'),
  ]),
)
const writes = new Set(['insert', 'update', 'delete', 'upsert'])
// These modules construct disposable test data, never application records.
const fixtures = new Set(['library/fixtures.ts', 'runtime/chains.ts'])

function declarations(symbol) {
  return symbol.declarations.map((handle) => handle.resolve()).filter((node) => node !== undefined)
}

function findAncestor(node, predicate) {
  let current = node
  while (current !== undefined) {
    if (predicate(current)) return current
    current = current.parent
  }
  return undefined
}

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
  return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
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
  if (symbol === undefined) return false
  for (const declaration of declarations(symbol)) {
    const imported = ts.isImportSpecifier(declaration)
      ? (declaration.propertyName ?? declaration.name).text
      : propertyName(expression)
    const module = findAncestor(declaration, ts.isImportDeclaration)
    if (
      module !== undefined &&
      module.moduleSpecifier.text === 'drizzle-orm/pg-core' &&
      imported === 'pgTable'
    )
      return true
  }
  return false
}

/** Type queries and their aliases retain every possible target of a parameterized write. */
function tablesInType(checker, node, tables, seen) {
  if (ts.isTypeQueryNode(node)) return tablesOf(checker, node.exprName, tables, seen)
  if (ts.isParenthesizedTypeNode(node)) return tablesInType(checker, node.type, tables, seen)
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap((member) => tablesInType(checker, member, tables, new Set(seen)))
  }
  if (ts.isTypeReferenceNode(node)) return tablesOf(checker, node.typeName, tables, seen)
  return [undefined]
}

/** Unknown targets remain in the result so aliases, unions and destructuring fail closed. */
function tablesOf(checker, expression, tables, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return tablesOf(checker, expression.expression, tables, seen)
  }
  const symbol = symbolOf(checker, expression)
  if (symbol === undefined || seen.has(symbol)) return [undefined]
  const table = tables.get(symbol)
  if (table !== undefined) return [table]
  seen.add(symbol)
  for (const declaration of declarations(symbol)) {
    if (declaration.type !== undefined) {
      return tablesInType(checker, declaration.type, tables, seen)
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return tablesOf(checker, declaration.initializer, tables, seen)
    }
  }
  return [undefined]
}

/** Only known non-builder SDK APIs may bypass an unresolved table target. */
function nonBuilderImport(declaration, imported) {
  const module = imported.moduleSpecifier.text
  if (['node:crypto', 'effect/Ref', 'effect/http/HttpClientRequest'].includes(module)) return true
  if (!ts.isImportSpecifier(declaration)) return false
  const name = (declaration.propertyName ?? declaration.name).text
  return (
    (module === 'effect' && name === 'Ref') ||
    (module === 'effect/http' && name === 'HttpClientRequest')
  )
}

/** Imported non-Drizzle APIs and built-in collections can prove a same-named call unrelated. */
function unrelatedReceiver(checker, node, seen = new Set()) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return unrelatedReceiver(checker, node.expression, seen)
  }
  if (ts.isCallExpression(node) || ts.isParenthesizedExpression(node)) {
    return unrelatedReceiver(checker, node.expression, seen)
  }
  if (ts.isNewExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.expression.text)
    )
  }
  const symbol = checker.getSymbolAtLocation(node)
  if (symbol === undefined || seen.has(symbol)) return false
  seen.add(symbol)
  return declarations(symbol).some((declaration) => {
    const imported = findAncestor(declaration, ts.isImportDeclaration)
    if (imported !== undefined) {
      return nonBuilderImport(declaration, imported)
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return unrelatedReceiver(checker, declaration.initializer, seen)
    }
    return false
  })
}

/** Local bodies are audited where they construct queries, including methods bound by callers. */
function implementedDeclaration(checker, declaration, seen) {
  if (declaration.getSourceFile().fileName.startsWith('/typescript/')) return true
  if (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration))
    return declaration.body !== undefined
  if (ts.isPropertyAssignment(declaration))
    return (
      ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer)
    )
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    return locallyImplemented(checker, declaration.initializer, seen)
  }
  return false
}

/** Binding a method preserves its implementation and must not conceal a Drizzle mutation. */
function boundReceiver(expression) {
  if (!ts.isCallExpression(expression) || propertyName(expression.expression) !== 'bind')
    return undefined
  return expression.expression.expression
}

/** Local implementations are audited at their own builder calls, rather than at their callers. */
function locallyImplemented(checker, expression, seen = new Set()) {
  const bound = boundReceiver(expression)
  if (bound !== undefined) return locallyImplemented(checker, bound, seen)
  const symbol = symbolOf(checker, expression)
  if (symbol === undefined || seen.has(symbol)) return false
  seen.add(symbol)
  return declarations(symbol).some((declaration) =>
    implementedDeclaration(checker, declaration, seen),
  )
}

/** Destructured dependencies retain the parameter's declared fields through a local alias. */
function dependencyField(checker, receiver) {
  const symbol = checker.getSymbolAtLocation(receiver)
  if (symbol === undefined) return undefined
  const binding = declarations(symbol).find(ts.isBindingElement)
  if (binding === undefined) return undefined
  let parameter = binding.parent.parent
  if (ts.isVariableDeclaration(parameter) && parameter.initializer !== undefined) {
    const input = symbolOf(checker, parameter.initializer)
    if (input === undefined) return undefined
    parameter = declarations(input)[0]
  }
  if (parameter.type === undefined || !ts.isTypeLiteralNode(parameter.type)) return undefined
  return parameter.type.members.find(
    (member) => member.name !== undefined && member.name.getText() === binding.name.getText(),
  )
}

/** The second Context.Service type argument owns the service's explicitly declared operations. */
function serviceInterface(checker, declaration) {
  if (!ts.isClassDeclaration(declaration) || declaration.heritageClauses === undefined)
    return undefined
  const base = declaration.heritageClauses[0].types[0].expression
  if (!ts.isCallExpression(base) || !ts.isCallExpression(base.expression)) return undefined
  const factory = base.expression
  if (factory.typeArguments === undefined || factory.typeArguments.length !== 2) return undefined
  return checker.getTypeFromTypeNode(factory.typeArguments[1])
}

/** An explicitly declared Effect command is executed by its service, rather than a query builder. */
function effectCommand(property) {
  if (property === undefined) return false
  return declarations(property).some((declaration) => {
    const signature = declaration.type
    if (signature === undefined || !ts.isFunctionTypeNode(signature)) return false
    const result = signature.type
    if (!ts.isTypeReferenceNode(result) || !ts.isQualifiedName(result.typeName)) return false
    return result.typeName.left.getText() === 'Effect' && result.typeName.right.text === 'Effect'
  })
}

/** Context.Service exposes locally declared methods even without loading its SDK declarations. */
function localServiceMethod(checker, expression) {
  if (!ts.isPropertyAccessExpression(expression)) return false
  const field = dependencyField(checker, expression.expression)
  if (field === undefined || field.type === undefined || !ts.isIndexedAccessTypeNode(field.type))
    return false
  if (!ts.isTypeReferenceNode(field.type.objectType)) return false
  const service = symbolOf(checker, field.type.objectType.typeName)
  if (service === undefined) return false
  return declarations(service).some((declaration) => {
    const type = serviceInterface(checker, declaration)
    return type !== undefined && effectCommand(type.getProperty(expression.name.text))
  })
}

/** A declared local function named insert is not itself evidence of a Drizzle builder. */
function operationBinding(declaration) {
  return (
    ts.isBindingElement(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isVariableDeclaration(declaration)
  )
}

/** Each supported binding form retains the original mutation name at its declaration. */
function declaredOperation(checker, declaration, seen) {
  if (ts.isBindingElement(declaration) || ts.isImportSpecifier(declaration)) {
    const name = (declaration.propertyName ?? declaration.name).getText()
    return writes.has(name) ? name : undefined
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    return operationOf(checker, declaration.initializer, seen)
  }
  return undefined
}

/** Renamed or destructured builder methods retain the mutation name at their call site. */
function operationOf(checker, expression, seen = new Set()) {
  const bound = boundReceiver(expression)
  if (bound !== undefined) return operationOf(checker, bound, seen)
  const property = propertyName(expression)
  if (property !== undefined) return writes.has(property) ? property : undefined
  const named =
    ts.isIdentifier(expression) && writes.has(expression.text) ? expression.text : undefined
  const symbol = symbolOf(checker, expression)
  if (symbol === undefined || seen.has(symbol)) return named
  seen.add(symbol)
  const declaration = declarations(symbol).find(operationBinding)
  return declaration === undefined ? named : declaredOperation(checker, declaration, seen)
}

/** Table declarations, rather than a hand-maintained table list, identify each owning domain. */
function programSources(program) {
  return program.getSourceFileNames().map((file) => ({
    file: file.slice(1),
    source: program.getSourceFile(file),
  }))
}

function declaredTables(program, checker) {
  const tables = new Map()
  for (const { file, source } of programSources(program)) {
    if (!file.startsWith(serverRoot)) continue
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        isTableFactory(checker, node.initializer.expression)
      ) {
        const path = file.slice(serverRoot.length).split('/')
        const domain = path.length > 1 ? path[0] : undefined
        tables.set(checker.getSymbolAtLocation(node.name), { domain, name: node.name.text })
      }
      node.forEachChild(visit)
    }
    visit(source)
  }
  return tables
}

/** A virtual filesystem makes historical module resolution independent of cwd and disk. */
function sourceProgram(api, sources) {
  return api.createSnapshot({
    fileSystem: createFileSystem([
      ...Array.from(sources, ([file, text]) => [`/${file}`, text]),
      ...libraries,
    ]),
    createPrograms: [
      {
        rootFiles: [...sources.keys()].map((file) => `/${file}`).concat([...libraries.keys()]),
        compilerOptions: {
          noResolve: true,
          noLib: true,
          types: [],
          allowImportingTsExtensions: true,
          module: ModuleKind.NodeNext,
          moduleResolution: ModuleResolutionKind.NodeNext,
        },
      },
    ],
  })
}

/** Excluded test support must stay unreachable from production, including through re-exports. */
function excludedImport(node, file, sources) {
  let specifier
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      node.expression.getText() === 'require')
  ) {
    specifier = node.arguments[0]
  }
  if (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.'))
    return undefined
  const target = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(file), specifier.text),
  )
  const resolved = [
    target,
    target.replace(/\.js$/u, '.ts'),
    `${target}.ts`,
    `${target}/index.ts`,
  ].find((file) => sources.has(file))
  return resolved !== undefined && !isWriter(resolved) ? resolved : undefined
}

/** Unresolved mutation targets are findings, never evidence that a write is legal. */
function writeFindings(checker, node, tables, domain) {
  if (!ts.isCallExpression(node)) return []
  const operation = operationOf(checker, node.expression)
  if (operation === undefined) return []
  // Only insert accepts additional column arguments in the pinned PostgreSQL builder API.
  if (operation !== 'insert' && node.arguments.length > 1) return []
  const targets =
    node.arguments.length === 0 ? [undefined] : tablesOf(checker, node.arguments[0], tables)
  if (
    unrelatedReceiver(checker, node.expression) ||
    locallyImplemented(checker, node.expression) ||
    localServiceMethod(checker, node.expression)
  )
    return []
  return [...new Set(targets)].flatMap((table) => {
    if (table === undefined)
      return [
        {
          message: `${operation} target is unresolved; for a non-Drizzle receiver whose type cannot be resolved without SDK types, add an explicit type annotation on the receiver`,
        },
      ]
    return table.domain === domain ? [] : [{ operation, table: table.name, owner: table.domain }]
  })
}

/**
 * Check Drizzle builder writes using syntax and resolved local symbols, without loading SDKs.
 * Reads, joins and membership checks are legal. Raw SQL writes are outside this check.
 * Sources map repository-relative paths to text for working trees and historical replays.
 */
function checkOwners(sources) {
  using api = new API({ cwd: '/' })
  using snapshot = sourceProgram(api, sources)
  const program = snapshot.operation.createdPrograms[0]
  const checker = program.getProject().checker
  const tables = declaredTables(program, checker)
  const domains = new Set(
    [...tables.values()].flatMap((table) => (table.domain === undefined ? [] : [table.domain])),
  )
  if (tables.size === 0 || domains.size === 0) {
    return [
      {
        file: serverRoot,
        line: 1,
        message: 'ownership resolution found zero tables or zero domains; refusing to pass',
      },
    ]
  }
  const findings = []
  for (const { file, source } of programSources(program)) {
    if (!file.startsWith(serverRoot) || !isWriter(file)) continue
    const domain = file.slice(serverRoot.length).split('/')[0]
    const visit = (node) => {
      const violations = writeFindings(checker, node, tables, domain)
      const excluded = excludedImport(node, file, sources)
      if (excluded !== undefined)
        violations.push({
          message: `production imports excluded test support ${excluded}`,
        })
      if (violations.length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        findings.push(
          ...violations.map((violation) => Object.assign({ file, line: line + 1 }, violation)),
        )
      }
      node.forEachChild(visit)
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
function main(args) {
  const { values } = NodeUtil.parseArgs({
    args,
    options: { root: { type: 'string' }, ref: { type: 'string' } },
  })
  const root = values.root === undefined ? repositoryRoot : NodePath.resolve(values.root)
  const findings = checkOwners(sourcesAt(root, values.ref))
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}: ${finding.message ?? `${finding.operation}(${finding.table}) belongs to ${finding.owner}; call its owning service`}\n`,
    )
  }
  if (findings.length > 0) return 1
  process.stdout.write(
    'owners PASS: every server Drizzle builder write stays in its owning domain\n',
  )
  return 0
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2))
}

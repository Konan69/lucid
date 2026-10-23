import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { API, ModuleResolutionKind } from 'tsc-rs/unstable/sync'
import { isStringLiteral, parseSource, walk } from '../syntax.mjs'

function importedSpecifiers(node) {
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type))
    return node.source === null ? [] : [node.source.value]
  if (['ImportExpression', 'TSImportType'].includes(node.type) && isStringLiteral(node.source))
    return [node.source.value]
  if (node.type === 'TSExternalModuleReference' && isStringLiteral(node.expression))
    return [node.expression.value]
  if (node.type !== 'CallExpression') return []
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return []
  const argument = node.arguments[0]
  return argument !== undefined && isStringLiteral(argument) ? [argument.value] : []
}

function readsDatabase(node) {
  if (node.type === 'Identifier') return node.name === 'VIVID_TEST_DATABASE_URL'
  return isStringLiteral(node) && node.value === 'VIVID_TEST_DATABASE_URL'
}

function sourceImports(file, source) {
  let database = false
  const imports = []
  walk(parseSource(file, source), (node) => {
    if (readsDatabase(node)) database = true
    imports.push(...importedSpecifiers(node))
  })
  return { database, imports }
}

export function needsDatabase(tree, files) {
  using api = new API({ cwd: tree })
  using resolver = api.createModuleResolver({
    moduleResolution: ModuleResolutionKind.Bundler,
    allowJs: true,
  })
  const pending = files.map((file) => NodePath.join(tree, file))
  const visited = new Set()
  while (pending.length > 0) {
    const file = NodeFS.realpathSync(pending.pop())
    if (visited.has(file) || file.includes('node_modules/') || !/\.[cm]?[jt]sx?$/u.test(file))
      continue
    visited.add(file)
    const scanned = sourceImports(file, NodeFS.readFileSync(file, 'utf8'))
    if (scanned.database) return true
    for (const specifier of scanned.imports) {
      const resolved = resolver.resolveModuleName(specifier, NodePath.dirname(file)).resolvedModule
      if (resolved !== undefined) pending.push(resolved.resolvedFileName)
    }
  }
  return false
}

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import ts from 'typescript'

/** Resolve source imports without booting Vitest or executing a test's database setup. */
const resolution = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }

/** Database suites opt in by reading the isolated test variable, directly or through a fixture. */
function readsDatabase(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node) => {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      node.text === 'VIVID_TEST_DATABASE_URL'
    )
      found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

/**
 * Follow workspace and relative imports to the fixture that owns database authority. Pure
 * Vitest projects need no Docker server. Recompute after reversal because imports can change.
 * External dependency declarations cannot request a product test database.
 */
export function needsDatabase(tree, files) {
  const pending = files.map((file) => NodePath.join(tree, file))
  const visited = new Set()
  while (pending.length > 0) {
    const file = NodeFS.realpathSync(pending.pop())
    if (visited.has(file) || file.includes('node_modules/')) continue
    visited.add(file)
    const source = NodeFS.readFileSync(file, 'utf8')
    if (readsDatabase(file, source)) return true
    const imports = ts.preProcessFile(source, true, true).importedFiles
    for (const entry of imports) {
      const resolved = ts.resolveModuleName(entry.fileName, file, resolution, ts.sys).resolvedModule
      if (resolved !== undefined) pending.push(resolved.resolvedFileName)
    }
  }
  return false
}

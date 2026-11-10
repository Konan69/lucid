import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'

/** Package-local runners share Vitest identity with their tests, including pnpm peer variants. */
export function vitestGroups(root, files) {
  const groups = new Map()
  for (const file of files) {
    const absolute = NodePath.resolve(root, file)
    let cwd = NodePath.dirname(absolute)
    while (cwd !== root && !NodeFS.existsSync(NodePath.join(cwd, 'package.json')))
      cwd = NodePath.dirname(cwd)
    if (!groups.has(cwd)) {
      const require = NodeModule.createRequire(NodePath.join(cwd, 'package.json'))
      const runner = NodePath.join(
        NodePath.dirname(require.resolve('vitest/package.json')),
        'vitest.mjs',
      )
      groups.set(cwd, { kind: 'vitest', cwd, runner, files: [] })
    }
    groups.get(cwd).files.push(NodePath.relative(cwd, absolute))
  }
  return [...groups.values()]
}

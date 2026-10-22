import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

const executable = process.argv[1]
if (executable !== undefined && NodeFS.existsSync(executable)) {
  const resolved = NodeFS.realpathSync(executable)
  const compilerPackage =
    /(?:^|[/\\])node_modules[/\\](?:typescript|@typescript[/\\][^/\\]+)(?:[/\\]|$)/u
  const compilerName = /^(?:tsc|tsgo)(?:\.(?:[cm]?js|cmd))?$/u
  if (
    compilerPackage.test(resolved) ||
    compilerPackage.test(executable) ||
    compilerName.test(NodePath.basename(executable))
  )
    throw new Error('Use pnpm check <project> through the pinned scripts/types.mjs runner.')
}

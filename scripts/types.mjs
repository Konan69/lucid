import * as NodeChildProcess from 'node:child_process'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

/**
 * The type checker: tsc-rs (pingdotgg/ts-rust), a Rust port of the native TypeScript compiler
 * with the same command line and the Effect language service rules built in. Measured on this
 * repository on 7 Oct 2026 (docs/checks.md): the whole typecheck graph cold in 11 s against 28 s
 * for native `tsc` 7.0.2 with one checker, at the same 2 GB peak, and the same diagnostics.
 * Linux x64 and macOS arm64 only. `@typescript/native` stays installed for typed lint and
 * editors, and `apps/web`'s build still compiles with it.
 */
export const typeChecker = 'node_modules/tsc-rs/bin/tsc-rs'

/**
 * Turbo already restores declaration prerequisites and hashes source contents.
 * Project mode checks those contents against incremental data instead of build
 * mode's timestamp shortcut, which can miss errors after restoring newer cache
 * outputs. Direct package commands still build referenced projects, forcing the
 * timestamp check because Turbo has not prepared or validated their outputs.
 * Both paths keep one checker; direct builds also keep one project builder.
 * TURBO_HASH is the documented task marker:
 * https://turborepo.dev/docs/reference/system-environment-variables
 */
export function runTypes(root, cwd, projects, environment) {
  const compiler = NodePath.join(root, typeChecker)
  const selected = projects.length === 0 ? ['tsconfig.json'] : projects
  const commands =
    environment.TURBO_HASH === undefined
      ? [['-b', ...selected, '--force', '--checkers', '1', '--builders', '1']]
      : selected.map((project) => ['-p', project, '--checkers', '1'])
  for (const args of commands) {
    const result = NodeChildProcess.spawnSync(process.execPath, [compiler, ...args], {
      cwd,
      env: environment,
      stdio: 'inherit',
    })
    if (result.error !== undefined) {
      process.stderr.write(`could not start TypeScript: ${result.error.message}\n`)
      return 1
    }
    if (result.status === null) return 1
    if (result.status !== 0) return result.status
  }
  return 0
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  process.exitCode = runTypes(repositoryRoot, process.cwd(), process.argv.slice(2), process.env)
}

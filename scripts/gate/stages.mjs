/**
 * The one definition of the gate. The push hook, the Cloudbox run and each GitHub job select
 * stages from this table through `scripts/gate.mjs`; none of them lists a check of its own.
 *
 * A stage is either `commands` (policy checks that read the whole repository in a second or two
 * and so always run) or Turbo `tasks` (hashed per package, replayed when their inputs are
 * unchanged). Turbo stages belong to a lane, and each lane is one Turbo invocation:
 *
 * - `checks` runs one task at a time. Typed lint and native typechecking each hold a whole
 *   TypeScript program in memory (docs/checks.md measured 3.6 GiB for one tsgolint process), so
 *   two of them never overlap.
 * - `tests` runs beside it. Vitest workers are plain Node processes with no compiler heap, and
 *   the tasks here depend only on input-hash tasks that execute nothing, so the two invocations
 *   never build the same output.
 */
export const stages = [
  {
    name: 'policy',
    commands: [
      ['node', 'scripts/package-manager.mjs'],
      ['node', 'scripts/versions.mjs'],
      ['node', 'scripts/instructions.mjs'],
      ['node', 'scripts/effect-boundary-audit.mjs', 'enforce'],
      ['node', 'scripts/migrations.mjs', 'check'],
      ['node', 'scripts/owners.mjs'],
      // Structure: one-word names, no dumping grounds, server layering (docs/00-structure.md).
      ['pnpm', 'exec', 'konsistent'],
    ],
  },
  { name: 'lint', lane: 'checks', tasks: ['lint', 'lint:root'] },
  { name: 'format', lane: 'checks', tasks: ['format:root'] },
  // `types` emits the declarations that `typecheck` consumers read; Turbo orders them.
  { name: 'typecheck', lane: 'checks', tasks: ['types', 'typecheck', 'typecheck:root'] },
  // The tooling tests run compilers only on small fixtures, so they sit beside the tests. The
  // infrastructure check reads server and runtime source and is a task of its own: a server
  // change reruns that second of work, not every tooling test.
  { name: 'tooling', lane: 'tests', tasks: ['test:tooling', 'test:infra'] },
  { name: 'test', lane: 'tests', tasks: ['test'] },
]

export const stageNames = stages.map((stage) => stage.name)

/** The stage that owns a Turbo task id such as `@vivid/server#lint` or `//#lint:root`. */
export function stageOfTask(taskId) {
  const task = taskId.slice(taskId.indexOf('#') + 1)
  return stages.find((stage) => stage.tasks !== undefined && stage.tasks.includes(task))
}

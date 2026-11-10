/**
 * The one definition of the gate. The push hook, the Cloudbox run and each GitHub job select
 * stages from this table through `scripts/gate.mjs`; none of them lists a check of its own.
 *
 * A stage is either `commands` (policy checks that read the whole repository in a second or two
 * and so always run) or Turbo `tasks` (hashed per package, replayed when their inputs are
 * unchanged). Turbo stages belong to a lane, and each lane is one Turbo invocation:
 *
 * - `checks` runs one task at a time. Typed lint and typechecking each keep compiler state
 *   in memory, so two of them never overlap.
 * - `tests` runs beside it. Vitest workers are plain Node processes with no compiler heap, and
 *   the tasks here depend only on input-hash tasks that execute nothing, so the two invocations
 *   never build the same output.
 */
export const stages = [
  {
    name: 'policy',
    commands: [
      ['node', 'scripts/package-manager.mjs'],
      ['node', 'scripts/compiler-policy.mjs'],
      ['node', 'scripts/versions.mjs'],
      ['node', 'scripts/instructions.mjs'],
      ['node', 'scripts/references.mjs'],
      ['node', 'scripts/tasks.mjs'],
      ['node', 'scripts/infra-verify.mjs'],
      ['node', 'scripts/effect-boundary-audit.mjs', 'enforce'],
      ['node', 'scripts/migrations.mjs', 'check'],
      ['node', 'scripts/owners.mjs'],
      ['node', 'scripts/deadcode.mjs'],
      ['node', 'scripts/rpccallers.mjs'],
      // Deploy commands are one program each, never a shell chain.
      ['node', 'scripts/gate/commands.mjs'],
      // Every schema the server and the cell both import is part of the contract fingerprint.
      ['node', 'scripts/gate/wire.mjs'],
      // Structure: one-word names, no dumping grounds, server layering (docs/00-structure.md).
      ['node', 'scripts/structure.mjs'],
    ],
  },
  { name: 'lint', lane: 'checks', tasks: ['lint', 'lint:root'] },
  { name: 'format', lane: 'checks', tasks: ['format:root'] },
  // `types` emits the declarations that `typecheck` consumers read; Turbo orders them.
  { name: 'typecheck', lane: 'checks', tasks: ['types', 'typecheck', 'typecheck:root'] },
  // Qualified tasks select production artifacts, including the native cell deployment receipt.
  // Source-only prerequisites avoid desktop binaries and the phone's generic export.
  // Bundlers share the serialized checks lane.
  {
    name: 'build',
    lane: 'checks',
    tasks: ['@vivid/web#build', '@vivid/mobile#build:updates', '@vivid/cells#build'],
  },
  // Tooling integration proofs run compilers on small fixtures beside the application tests.
  { name: 'tooling', lane: 'tests', tasks: ['test:tooling'] },
  { name: 'test', lane: 'tests', tasks: ['test'] },
  // Reversal reads branch history and must run afresh, outside Turbo's content-only cache.
  {
    name: 'proof',
    commands: [
      ['node', '--test', 'scripts/gate/database.test.mjs'],
      ['node', 'scripts/proof.mjs'],
    ],
  },
]

export const stageNames = stages.map((stage) => stage.name)

/** The stage that owns a Turbo task id such as `@vivid/server#lint` or `//#lint:root`. */
export function stageOfTask(taskId) {
  const task = taskId.slice(taskId.indexOf('#') + 1)
  return stages.find(
    (stage) =>
      stage.tasks !== undefined && (stage.tasks.includes(taskId) || stage.tasks.includes(task)),
  )
}

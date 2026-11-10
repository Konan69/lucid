import * as NodeProcess from 'node:process'
import * as NodeUtil from 'node:util'
import * as Alchemist from 'alchemy/Alchemist'
import * as Drift from 'alchemy/Drift'
import { Cause, Effect, Exit } from 'effect'

/**
 * Fails when production is not what this checkout declares, so a difference is a red run and not
 * something someone has to remember to look for. Live Railway settings had drifted from `main`
 * (the server's pre-deploy and start commands, and its source repository) with nobody noticing,
 * and the cell Worker stayed eleven days behind; this is the check that would have said so.
 *
 *   VIVID_DEPLOY_TARGET=production node infra/drift.mjs --stage production [--env-file FILE]
 *
 * It runs Alchemy's own drift detection (`alchemy/src/Drift.ts`: every resource's `read` against
 * its last deployed attributes) and Alchemy's own plan, and exits 1 when:
 * - a resource drifted or is missing: the attribute names that differ are printed, never values;
 * - a resource could not be checked: its provider has no `read`, so a side effect nobody can read
 *   back, or its state is mid-deploy;
 * - the plan for this checkout has changes: the state store is behind the program, which on a
 *   checkout of `main` means `main` was not deployed.
 * A failure to read state or a resource fails the run with Alchemy's own error, also exit 1.
 *
 * One difference is not drift: a `Railway.Service` whose deployments `Infra.Release` makes records
 * the deployment id from the last time its settings changed, while the release records the one
 * serving now (`infra/release.ts` reads it back, so a deploy Alchemy did not make still fails here).
 */
const { values } = NodeUtil.parseArgs({
  options: {
    stage: { type: 'string' },
    'env-file': { type: 'string' },
  },
})
if (values.stage === undefined) {
  NodeProcess.stderr.write('Usage: node infra/drift.mjs --stage <stage> [--env-file <file>]\n')
  NodeProcess.exit(2)
}

const target = {
  entrypoint: 'alchemy.run.ts',
  stage: values.stage,
  ...(values['env-file'] === undefined ? {} : { envFile: values['env-file'] }),
}

/** Attributes another resource owns, by resource type: compared there, ignored here. */
const ownedElsewhere = { 'Railway.Service': new Set(['deploymentId', 'deploymentStatus']) }

/** The top-level attribute names whose values differ, never the values themselves. */
function differing(type, expected = {}, actual = {}) {
  const ignored = ownedElsewhere[type] ?? new Set()
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((name) => !ignored.has(name))
    .filter((name) => JSON.stringify(expected[name]) !== JSON.stringify(actual[name]))
}

const program = Effect.gen(function* () {
  const session = yield* Alchemist.open(target)
  const stack = { name: session.stack.name, stage: session.stack.stage }
  const detected = yield* Drift.plan(stack).pipe(Effect.provide(session.context))
  const problems = []
  for (const [fqn, row] of Object.entries(detected.result.resources)) {
    if (row.action === 'unchanged') continue
    if (row.action === 'skipped') {
      problems.push(`${fqn} (${row.resourceType}) not checked: ${row.reason}`)
      continue
    }
    if (row.action === 'missing') {
      problems.push(`${fqn} (${row.resourceType}) is missing`)
      continue
    }
    const drift = detected.plan.resources[fqn]?.drift
    const names = differing(row.resourceType, drift?.expected, drift?.actual)
    if (names.length > 0) problems.push(`${fqn} (${row.resourceType}) drifted: ${names.join(', ')}`)
  }
  const planned = yield* Alchemist.Stack.plan({ target, operation: 'deploy' })
  if (Alchemist.Stack.hasChanges(planned.summary))
    problems.push(`this checkout is not deployed: ${JSON.stringify(planned.summary)}`)
  return problems
})

// This executable is the program's edge, so the Effect runs here.
// oxlint-disable-next-line vivid/no-runpromise-in-library
const exit = await Effect.runPromise(
  program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped, Effect.exit),
)
if (Exit.isFailure(exit)) {
  // The error's tag and message only: a whole error object can carry the values it was built from.
  const error = Cause.squash(exit.cause)
  const reason =
    error instanceof Error
      ? `${'_tag' in error ? error._tag : error.name}: ${error.message}`
      : 'failed'
  NodeProcess.stderr.write(`drift: could not be checked: ${reason}\n`)
  NodeProcess.exit(1)
}
for (const problem of exit.value) NodeProcess.stderr.write(`drift: ${problem}\n`)
NodeProcess.stdout.write(
  exit.value.length === 0 ? 'drift: none\n' : `drift: ${exit.value.length} found\n`,
)
NodeProcess.exit(exit.value.length === 0 ? 0 : 1)

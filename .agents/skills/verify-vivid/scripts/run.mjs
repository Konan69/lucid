import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

/**
 * `verify run <feature>...`: one proof of the touched features, start to finish, in this checkout.
 *
 * The step commands each take one agent turn and leave the ordering to the agent: Launch before
 * Doctor, a worthy Doctor before any journey, `feature` and `browser` against one unchanged
 * launch, and Cleanup after the last journey even when one failed. On cloudbox-konan2 on
 * 11 November 2026 the gaps between those turns were 2 to 5 minutes each, and one checkout
 * launched four times in fifteen minutes. This runs the same commands in that order, always
 * cleans up, and writes one `run.json` naming every step's verdict and the evidence directory.
 *
 * A browser step with no recipe for a feature reports `blocked`, as `browser` itself does. The
 * exit is 0 only when every step proved its feature; `blocked` and `plumbing-only` are not proof.
 */
const skill = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)))
const root = NodePath.resolve(skill, '../../..')
const verify = NodePath.join(skill, 'verify')
const cache = process.env.VIVID_VERIFY_CACHE ?? NodePath.join(root, '.cache/verify')
const features = process.argv.slice(2)
if (features.length === 0 || features.some((feature) => !/^[a-z-]+$/u.test(feature)))
  throw new Error('Usage: verify run <feature>...  (names from features/README.md)')

/** One step command; its output streams through and its last verdict line is kept. */
function step(args) {
  const result = NodeChildProcess.spawnSync(verify, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  process.stdout.write(result.stdout)
  const verdicts = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"verdict"'))
    .map((line) => JSON.parse(line))
  return { exit: result.status, verdict: verdicts.at(-1)?.verdict }
}

const steps = []
const record = (name, feature, outcome) => steps.push({ step: name, feature, ...outcome })

const launched = step(['launch'])
record('launch', null, launched)
const run = NodeFS.existsSync(NodePath.join(cache, 'current'))
  ? NodeFS.readFileSync(NodePath.join(cache, 'current'), 'utf8').trim()
  : undefined
// Launch writes `current` before it starts anything, so a failed launch still names what to clean.
try {
  if (launched.exit === 0) {
    const doctor = step(['doctor', run])
    record('doctor', null, doctor)
    if (doctor.exit === 0)
      for (const feature of features) {
        record('feature', feature, step(['feature', feature, run]))
        record('browser', feature, step(['browser', feature, run]))
      }
  }
} finally {
  if (run !== undefined) record('cleanup', null, step(['cleanup', run]))
}

const journeys = steps.filter((entry) => entry.feature !== null)
const proved =
  journeys.length === features.length * 2 &&
  journeys.every((entry) => entry.exit === 0 && entry.verdict === 'proved') &&
  steps.every((entry) => entry.exit === 0)
const evidence = run === undefined ? null : NodePath.join(cache, run)
const summary = { run: run ?? null, features, proved, steps, evidence }
if (evidence !== null && NodeFS.existsSync(evidence))
  NodeFS.writeFileSync(NodePath.join(evidence, 'run.json'), JSON.stringify(summary, null, 2) + '\n')
process.stdout.write(JSON.stringify(summary) + '\n')
process.exitCode = proved ? 0 : 1

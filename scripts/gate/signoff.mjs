import * as NodeChildProcess from 'node:child_process'

/**
 * Signing off: telling GitHub that the commit about to be pushed has already passed the gate.
 *
 * The gate runs where the work is (this machine, or a warm tree on the gate host), and GitHub
 * then ran every stage again on cold machines for the same commit. A passed gate now leaves a
 * commit status named `gate` on that commit, and the Quality workflow reads it first and skips
 * its own run when it is there (`.github/workflows/quality.yml`, job `signoff`). A commit pushed
 * without one (no hook, `HUSKY=0`, a pull request from elsewhere) is still gated by GitHub.
 *
 * The idea is Basecamp's `gh-signoff` (run CI locally, then mark the commit green yourself).
 * Theirs signs a commit that is already on GitHub. Ours signs in the push hook, before the
 * push, so the status is there when the workflow starts; see `publish` for what that needs.
 */

/** The status GitHub's workflow looks for. One name, shared with `quality.yml`. */
const CONTEXT = 'gate'

/**
 * Whether a passed run is one to sign: the whole gate, on exactly the commit being pushed.
 * `--only` ran part of it, `affected` and `focused` skip tests, and without `--committed` the
 * run may have included work that is not in the commit.
 */
export const signable = (options) =>
  options.mode === 'full' && options.only === undefined && options.committed === true

/** `owner/name` from a GitHub remote address, in either form git writes it. */
function repositoryOf(address) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/u.exec(address.trim())
  return match === null ? undefined : match[1]
}

const run = (command, args, root, environment) =>
  NodeChildProcess.spawnSync(command, args, { cwd: root, env: environment, encoding: 'utf8' })

/**
 * The credential git itself would push this repository with, asked of git (`git credential
 * fill`), so the status is posted by the identity that is about to push. `gh` on its own uses
 * its active account, and on a machine signed in to two that was the other one: the first
 * signoff, of e1e3519f, was refused with 404 while the push beside it went through. With no
 * stored credential (an SSH remote) there is nothing to add and `gh` uses its own.
 */
function pushing(repository, at) {
  const asked = NodeChildProcess.spawnSync('git', ['credential', 'fill'], {
    cwd: at.root,
    env: { ...at.environment, GIT_TERMINAL_PROMPT: '0' },
    input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
    encoding: 'utf8',
  })
  const secret = /^password=(.+)$/mu.exec(asked.status === 0 ? asked.stdout : '')
  return secret === null ? at.environment : { ...at.environment, GH_TOKEN: secret[1] }
}

/** One status call. `at` is where commands run: the checkout and its environment. */
const post = (status, at) =>
  run(
    'gh',
    [
      'api',
      '--silent',
      '-X',
      'POST',
      `repos/${status.repository}/statuses/${status.sha}`,
      '-f',
      'state=success',
      '-f',
      `context=${CONTEXT}`,
      '-f',
      `description=${status.description.slice(0, 140)}`,
    ],
    at.root,
    at.environment,
  )

/**
 * Puts the status on the commit. GitHub only takes a status for a commit it has, and in the push
 * hook the commit has not arrived yet, so a first refusal sends the commit ahead under a ref of
 * its own (`refs/gate/<sha>`, outside branches and tags, so nothing builds or lists it), signs
 * it, and removes the ref; the push that follows makes the commit reachable for good.
 * `--no-verify` keeps that push from starting this hook again.
 */
function publish(status, at) {
  if (post(status, at).status === 0) return true
  const ref = `refs/gate/${status.sha}`
  const push = (refspec) =>
    run('git', ['push', '--quiet', '--no-verify', 'origin', refspec], at.root, at.environment)
  if (push(`${status.sha}:${ref}`).status !== 0) return false
  const signed = post(status, at).status === 0
  push(`:${ref}`)
  return signed
}

/**
 * Signs HEAD off after a passed gate, and says in one line what happened. It never fails the
 * gate: the commit did pass, and an unsigned commit only means GitHub checks it again.
 */
export function signoff(root, environment, where) {
  const sha = run('git', ['rev-parse', 'HEAD'], root, environment).stdout.trim()
  // The configured address, not `git remote get-url`: that one applies `insteadOf` rewrites, and
  // the repository's name on GitHub is in what was configured.
  const address = run('git', ['config', '--get', 'remote.origin.url'], root, environment).stdout
  const repository = repositoryOf(address)
  if (repository === undefined) return 'signoff skipped: origin is not a GitHub repository\n'
  const status = { repository, sha, description: `Passed the full gate on ${where}` }
  const signed = publish(status, { root, environment: pushing(repository, { root, environment }) })
  return signed
    ? `signoff ${CONTEXT} sha=${sha.slice(0, 12)} on ${repository}\n`
    : `signoff FAILED sha=${sha.slice(0, 12)}: GitHub will run the gate itself (is gh signed in?)\n`
}

#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

/**
 * The whole body a `CLAUDE.md` may have. Claude Code reads `CLAUDE.md` and expands an `@path`
 * line into that file; Codex and the other harnesses read `AGENTS.md`. Rules written in both
 * drift apart, so they live once, in `AGENTS.md`, and `CLAUDE.md` only imports it.
 */
export const importLine = '@AGENTS.md\n'

/**
 * List the tracked instruction files. Git is the source because untracked reference checkouts
 * (`refs/`) and dependencies carry their own `AGENTS.md` and `CLAUDE.md`, which are not ours.
 */
function trackedInstructionFiles(root) {
  const listed = NodeChildProcess.execFileSync(
    'git',
    ['ls-files', '-z', '--', '*AGENTS.md', '*CLAUDE.md', 'AGENTS.md', 'CLAUDE.md'],
    { cwd: root, encoding: 'utf8' },
  )
  return [...new Set(listed.split('\0').filter((path) => path !== ''))]
}

/**
 * Check that every directory with an `AGENTS.md` has a `CLAUDE.md` beside it holding only the
 * import line, and that no `CLAUDE.md` stands without the file it imports. Each error names the
 * file to change and what to write.
 */
export function validateInstructions(root, files = trackedInstructionFiles(root)) {
  const errors = []
  const present = new Set(files)
  for (const file of files.toSorted((left, right) => left.localeCompare(right))) {
    const directory = NodePath.posix.dirname(file)
    const sibling = (name) => (directory === '.' ? name : `${directory}/${name}`)
    if (NodePath.posix.basename(file) === 'AGENTS.md') {
      if (!present.has(sibling('CLAUDE.md'))) {
        errors.push(`${sibling('CLAUDE.md')} is missing: create it with the single line @AGENTS.md`)
      }
      continue
    }
    if (!present.has(sibling('AGENTS.md'))) {
      errors.push(
        `${file} has no ${sibling('AGENTS.md')}: move its rules there and keep only @AGENTS.md`,
      )
      continue
    }
    const body = NodeFS.readFileSync(NodePath.join(root, file), 'utf8')
    if (body !== importLine) {
      errors.push(`${file} must be exactly @AGENTS.md: move its rules into ${sibling('AGENTS.md')}`)
    }
  }
  return errors
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  // A directory argument checks another tree, such as a past revision checked out elsewhere.
  const root =
    process.argv[2] === undefined
      ? NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
      : NodePath.resolve(process.argv[2])
  const errors = validateInstructions(root)
  if (errors.length > 0) {
    process.stderr.write(
      `instruction files failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`,
    )
    process.exitCode = 1
  } else {
    process.stdout.write('instruction files passed\n')
  }
}

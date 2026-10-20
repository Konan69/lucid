import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import { importLine, validateInstructions } from './instructions.mjs'

const assert = NodeAssert
const test = NodeTest.default

/**
 * The file list is passed in instead of read from git, so a fixture needs no repository of its
 * own; the directory is fresh so one case's files never satisfy another's.
 */
function check(files) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-instructions-'))
  try {
    for (const [path, body] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(root, path), body)
    }
    return validateInstructions(root, Object.keys(files))
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
}

/** The shape the repository keeps: rules in AGENTS.md, an import beside each. */
void test('a CLAUDE.md that only imports its AGENTS.md passes', () => {
  assert.deepEqual(
    check({
      'AGENTS.md': '# rules\n',
      'CLAUDE.md': importLine,
      'apps/server/AGENTS.md': '# server\n',
      'apps/server/CLAUDE.md': importLine,
    }),
    [],
  )
})

/** A CLAUDE.md with rules of its own is the drift this check exists for. */
void test('a CLAUDE.md with its own rules fails and names the file to move them to', () => {
  assert.deepEqual(
    check({ 'AGENTS.md': '# rules\n', 'CLAUDE.md': '# Vivid agent instructions\n\nown prose\n' }),
    ['CLAUDE.md must be exactly @AGENTS.md: move its rules into AGENTS.md'],
  )
})

/** Claude Code loads instructions from CLAUDE.md, so an AGENTS.md needs one beside it. */
void test('an AGENTS.md without a CLAUDE.md fails', () => {
  assert.deepEqual(check({ 'packages/agent/runtime/AGENTS.md': '# runtime\n' }), [
    'packages/agent/runtime/CLAUDE.md is missing: create it with the single line @AGENTS.md',
  ])
})

/** An import with nothing to import is a stale file. */
void test('a CLAUDE.md without an AGENTS.md fails', () => {
  assert.deepEqual(check({ 'docs/CLAUDE.md': importLine }), [
    'docs/CLAUDE.md has no docs/AGENTS.md: move its rules there and keep only @AGENTS.md',
  ])
})

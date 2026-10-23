import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import { checkReferences, repository } from './references.mjs'

const test = NodeTest.default
const assert = NodeAssert

const declarations = { generated: [], dependencies: [], empty: [], examples: [] }

/** Use Git and an ignored on-disk file so filesystem existence cannot stand in for source identity. */
void test('an ignored untracked source file cannot satisfy a reference', (context) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-references-'))
  context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  NodeChildProcess.execFileSync('git', ['init', '-q', directory])
  NodeFS.writeFileSync(NodePath.join(directory, '.gitignore'), 'apps/\n')
  NodeFS.writeFileSync(NodePath.join(directory, 'AGENTS.md'), '`apps/missing.ts`')
  NodeFS.mkdirSync(NodePath.join(directory, 'apps'))
  NodeFS.writeFileSync(NodePath.join(directory, 'apps/missing.ts'), '')
  NodeChildProcess.execFileSync('git', ['add', '--', '.gitignore', 'AGENTS.md'], { cwd: directory })
  assert.equal(checkReferences(repository(directory), declarations).length, 1)
})

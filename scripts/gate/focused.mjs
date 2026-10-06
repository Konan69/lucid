import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { openRunDatabase } from './database.mjs'
import { logged, readTestCounts, runIdentifier } from './process.mjs'

/**
 * Only the named test files, through the root Vitest config so each file runs in its own
 * package's project with that project's setup, and with a database of its own. This is the
 * loop for one failing suite; it is not a gate and its verdict line says `focused`.
 */
export async function runFocused(root, files, environment) {
  if (files.length === 0) throw new Error('focused needs at least one test file')
  const missing = files.filter((file) => !NodeFS.existsSync(NodePath.resolve(root, file)))
  if (missing.length > 0) throw new Error(`no such test file: ${missing.join(', ')}`)
  const runId = runIdentifier()
  const directory = NodePath.join(root, '.cache/gate/runs', runId)
  NodeFS.mkdirSync(directory, { recursive: true })
  const database = await openRunDatabase(root, environment, runId)
  const log = NodePath.join(directory, 'test.log')
  const result = NodePath.join(directory, 'tests.json')
  try {
    const vitest = await logged(
      [
        'node',
        'node_modules/vitest/vitest.mjs',
        'run',
        ...files.map((file) => NodePath.relative(root, NodePath.resolve(root, file))),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${result}`,
      ],
      { cwd: root, env: { ...environment, VIVID_TEST_DATABASE_URL: database.url, CI: '1' }, log },
    )
    const counts = readTestCounts(result)
    const failed = vitest.exit === 0 ? [] : [`vitest exited ${vitest.exit}`]
    // A filter that matches nothing must not read as a pass.
    if (vitest.exit === 0 && counts.files === 0) failed.push('no test file matched')
    return {
      runId,
      directory,
      seconds: vitest.seconds,
      counts,
      results: [
        { name: 'test', seconds: vitest.seconds, failed, detail: `${files.length} files`, log },
      ],
    }
  } finally {
    await database.close()
  }
}

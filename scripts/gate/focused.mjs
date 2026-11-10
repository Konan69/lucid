import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { openRunDatabase } from './database.mjs'
import { logged, readTestCounts, runIdentifier } from './process.mjs'
import { vitestGroups } from './vitest.mjs'

/**
 * Only the named test files, through each package's own Vitest and setup, with a database
 * of this run's own. This is the loop for one failing suite; it is not a gate and its
 * verdict line says `focused`.
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
  const counts = { tests: 0, skipped: 0, files: 0 }
  const failed = []
  let seconds = 0
  try {
    for (const [index, group] of vitestGroups(root, files).entries()) {
      const result = NodePath.join(directory, `tests-${index}.json`)
      const vitest = await logged(
        [
          process.execPath,
          group.runner,
          'run',
          ...group.files,
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${result}`,
        ],
        {
          cwd: group.cwd,
          env: { ...environment, VIVID_TEST_DATABASE_URL: database.url, CI: '1' },
          log,
        },
      )
      const collected = readTestCounts(result)
      for (const key of Object.keys(counts)) counts[key] += collected[key]
      seconds += vitest.seconds
      if (vitest.exit !== 0)
        failed.push(`${NodePath.relative(root, group.cwd)}: vitest exited ${vitest.exit}`)
      // A filter that matches nothing must not read as a pass.
      if (vitest.exit === 0 && collected.files === 0) failed.push('no test file matched')
    }
    return {
      runId,
      directory,
      seconds,
      counts,
      results: [{ name: 'test', seconds, failed, detail: `${files.length} files`, log }],
    }
  } finally {
    await database.close()
  }
}

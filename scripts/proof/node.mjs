import * as NodeFS from 'node:fs'

/** Node wraps assertion errors in testFailure; only its cause carries the assertion's stack. */
export default async function* proofReporter(events) {
  const tests = []
  let unhandled = 0
  for await (const event of events) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const test = event.data
    const error = test.details.error
    if (error !== undefined && error.failureType === 'subtestsFailed') continue
    const cause = error === undefined ? undefined : error.cause
    if (test.file === undefined) {
      unhandled += 1
      continue
    }
    tests.push({
      file: test.file,
      name: test.name,
      project: 'node',
      line: test.line,
      column: test.column,
      state: event.type === 'test:pass' && !test.skip && !test.todo ? 'passed' : 'failed',
      errors: cause === undefined ? [] : [{ name: cause.name, stack: cause.stack }],
    })
  }
  NodeFS.writeFileSync(process.env.VIVID_PROOF_REPORT, JSON.stringify({ tests, unhandled }))
  yield ''
}

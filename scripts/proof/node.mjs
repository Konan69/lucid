import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

/** Import failures may carry a plain cause; only an Error can supply an assertion stack. */
function caseReceipt(test, type) {
  const error = test.details.error
  const cause = error === undefined ? undefined : error.cause
  return {
    file: test.file,
    name: test.name,
    project: 'node',
    line: test.line,
    column: test.column,
    state: type === 'test:pass' && !test.skip && !test.todo ? 'passed' : 'failed',
    errors: cause instanceof Error ? [{ name: cause.name, stack: cause.stack }] : [],
  }
}

/** Node wraps assertion errors in testFailure; only its cause carries the assertion's stack. */
export default async function* proofReporter(events) {
  const tests = []
  let unhandled = 0
  let previousNesting = -1
  for await (const event of events) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const test = event.data
    // Results arrive in depth-first order, so a shallower result after a child is its parent.
    const parent = previousNesting > test.nesting
    previousNesting = test.nesting
    if (test.details.type === 'suite' || parent) continue
    // Node synthesizes a passing file result when a process exits before any case reports.
    if (NodePath.resolve(test.name) === test.file && event.type === 'test:pass') {
      unhandled += 1
      continue
    }
    const error = test.details.error
    if (error !== undefined && error.failureType === 'subtestsFailed') continue
    if (test.file === undefined) {
      unhandled += 1
      continue
    }
    tests.push(caseReceipt(test, event.type))
  }
  NodeFS.writeFileSync(process.env.VIVID_PROOF_REPORT, JSON.stringify({ tests, unhandled }))
  yield ''
}

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

const Receipt = Schema.Struct({
  tests: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      name: Schema.String,
      project: Schema.String,
      line: Schema.Number,
      column: Schema.Number,
      state: Schema.String,
      errors: Schema.Array(Schema.Struct({ name: Schema.String, stack: Schema.String })),
    }),
  ),
  unhandled: Schema.Number,
})
const decodeReceipt = Schema.decodeUnknownResult(Schema.fromJsonString(Receipt))

/** A missing or malformed receipt is a runner failure, never evidence against a fix. */
export function readReceipt(file) {
  if (!NodeFS.existsSync(file)) return { tests: [], unhandled: 1 }
  const decoded = decodeReceipt(NodeFS.readFileSync(file, 'utf8'))
  return Result.isFailure(decoded) ? { tests: [], unhandled: 1 } : decoded.success
}

/** Require the assertion's first user frame to be inside the case, excluding setup hooks. */
function assertionInBody(test, body) {
  return test.errors.some((error) => {
    if (error.name !== 'AssertionError') return false
    const frames = [
      ...error.stack.matchAll(
        /(?:\(|\s)(?:file:\/\/)?(?<file>[^()\n]+):(?<line>\d+):(?<column>\d+)\)?/gu,
      ),
    ]
    const frame = frames.find(
      ({ groups }) =>
        NodePath.isAbsolute(groups.file.trim()) && !groups.file.includes('node_modules/'),
    )
    if (frame === undefined) return false
    return (
      NodePath.resolve(frame.groups.file.trim()) === NodePath.resolve(test.file) &&
      Number(frame.groups.line) >= body.bodyStart &&
      Number(frame.groups.line) <= body.bodyEnd &&
      (Number(frame.groups.line) !== body.bodyStart ||
        Number(frame.groups.column) >= body.bodyStartColumn) &&
      (Number(frame.groups.line) !== body.bodyEnd ||
        Number(frame.groups.column) <= body.bodyEndColumn)
    )
  })
}

/** Match each executed case by project, file and declaration, including parameterized rows. */
export function judgeCase(test, body, reversed, tree) {
  const label = `${NodePath.relative(tree, test.file)}:${test.line} ${test.name}`
  if (test.state !== 'passed')
    return { state: 'INCONCLUSIVE', label, reason: 'case did not pass with the fix' }
  const red = reversed.tests.find(
    (candidate) =>
      candidate.file === test.file &&
      candidate.project === test.project &&
      candidate.line === test.line &&
      candidate.column === test.column &&
      candidate.name === test.name,
  )
  if (red === undefined)
    return { state: 'INCONCLUSIVE', label, reason: 'case did not collect without the fix' }
  if (red.state === 'passed') return { state: 'SURVIVED', label, reason: 'passes without the fix' }
  if (!assertionInBody(red, body))
    return {
      state: 'INCONCLUSIVE',
      label,
      reason: 'no assertion in the test body (import/setup/runtime failure)',
    }
  return { state: 'PROVEN', label, reason: 'AssertionError in named test body without the fix' }
}

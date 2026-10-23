import { parseSource, sourcePositions, walk } from '../syntax.mjs'

export function testBodies(path, source) {
  const bodies = []
  const position = sourcePositions(source)
  walk(parseSource(path, source), (node) => {
    if (node.type !== 'CallExpression') return
    const callback = node.arguments.find((argument) =>
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type),
    )
    if (callback === undefined) return
    const start = position(node.start)
    const end = position(node.end)
    const bodyStart = position(callback.body.start)
    const bodyEnd = position(callback.body.end)
    bodies.push({
      namedTest: /\b(?:it|test)\b/u.test(source.slice(node.callee.start, node.callee.end)),
      start: start.line,
      end: end.line,
      startColumn: start.column,
      endColumn: end.column,
      bodyStart: bodyStart.line,
      bodyEnd: bodyEnd.line,
      bodyStartColumn: bodyStart.column,
      bodyEndColumn: bodyEnd.column,
    })
  })
  return bodies
}

/** Zero-context hunks identify changed case bodies without treating every old case as new. */
export function changedLines(diff) {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/gmu)].map(
    ({ groups }) => {
      const start = Number(groups.start)
      const count = groups.count === undefined ? 1 : Number(groups.count)
      return { start: Math.max(1, start), end: start + Math.max(1, count) - 1 }
    },
  )
}

/** A case is declared before its callback body; enclosing suites and hooks cannot own it. */
export function caseBody(test, bodies) {
  return bodies.find(
    (body) =>
      test.line >= body.start &&
      (test.line !== body.start || test.column >= body.startColumn) &&
      test.line <= body.bodyStart &&
      (test.line !== body.bodyStart || test.column < body.bodyStartColumn),
  )
}

/** A parent declaration owns subtests, not an additional independently provable case. */
export function leafBodies(bodies) {
  return bodies.filter(
    (body) =>
      !bodies.some(
        (child) =>
          child !== body &&
          child.namedTest &&
          child.start >= body.bodyStart &&
          (child.start !== body.bodyStart || child.startColumn >= body.bodyStartColumn) &&
          child.end <= body.bodyEnd &&
          (child.end !== body.bodyEnd || child.endColumn <= body.bodyEndColumn),
      ),
  )
}

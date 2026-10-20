import ts from 'typescript'

/** Reporter locations identify cases even when a project aliases or wraps its test import. */
export function testBodies(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const bodies = []
  const line = (position) => file.getLineAndCharacterOfPosition(position).line + 1
  // Callback spans let the receipt distinguish a case assertion from enclosing fixture code.
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const body = node.arguments.find(
        (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      )
      if (body !== undefined)
        bodies.push({
          namedTest: /\b(?:it|test)\b/u.test(node.expression.getText(file)),
          start: line(node.getStart(file)),
          end: line(node.end),
          startColumn: file.getLineAndCharacterOfPosition(node.getStart(file)).character + 1,
          endColumn: file.getLineAndCharacterOfPosition(node.end).character + 1,
          bodyStart: line(body.body.getStart(file)),
          bodyEnd: line(body.body.end),
          bodyStartColumn:
            file.getLineAndCharacterOfPosition(body.body.getStart(file)).character + 1,
          bodyEndColumn: file.getLineAndCharacterOfPosition(body.body.end).character + 1,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
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

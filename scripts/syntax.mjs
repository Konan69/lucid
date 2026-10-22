import { parseSync, visitorKeys } from 'oxc-parser'
import * as Schema from 'effect/Schema'

const isString = Schema.is(Schema.String)

export function parseSource(file, source) {
  return parseSync(file, source, { astType: 'ts', range: true }).program
}

export function walk(node, visit, parent) {
  visit(node, parent)
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value.filter((entry) => entry !== null)) walk(child, visit, node)
    } else if (value !== null && value !== undefined) walk(value, visit, node)
  }
}

export function sourcePositions(source) {
  const starts = [0]
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/gu))
    starts.push(match.index + match[0].length)
  return (offset) => {
    let low = 0
    let high = starts.length
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2)
      if (starts[middle] <= offset) low = middle
      else high = middle
    }
    return { line: low + 1, column: offset - starts[low] + 1 }
  }
}

export function isStringLiteral(node) {
  return node.type === 'Literal' && isString(node.value)
}

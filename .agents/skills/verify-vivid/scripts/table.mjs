import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import { root } from './process.mjs'

const require = NodeModule.createRequire(root + '/packages/agent/runtime/package.json')
const { tokenize, split, parseExpression } = await import(require.resolve('@openuidev/lang-core'))
const columns = ['Project', 'Hours', 'Owner']
const rows = [
  ['Research', '4', 'Ada'],
  ['Writing', '3', 'Ben'],
  ['Review', '2', 'Cai'],
]

/** Inspect the shipped parser's component AST, so prose and quoted source cannot count as a Table. */
function tables(node) {
  if (node.k === 'Comp')
    return [...(node.name === 'Table' ? [node] : []), ...node.args.flatMap(tables)]
  if (node.k === 'Arr') return node.els.flatMap(tables)
  return []
}

/** This recipe requires literal cells; unsupported expressions fail rather than infer their values. */
function cells(node) {
  NodeAssert.equal(node.k, 'Arr', 'Table columns and rows must be arrays')
  return node.els.map((cell) => {
    NodeAssert.ok(['Str', 'Num'].includes(cell.k), 'Table cell must be a string or number')
    return String(cell.v)
  })
}

/** Only assistant fences supply candidate programs; the Person's requested data cannot pass. */
export async function assertTable(page) {
  const programs = page.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .flatMap((part) =>
      Array.from(part.text.matchAll(/```openui-lang\s*\n([\s\S]*?)```/g), (m) => m[1]),
    )
  NodeAssert.ok(programs.length > 0, 'No assistant openui-lang fence')
  const candidates = programs.flatMap((program) =>
    split(tokenize(program)).flatMap((statement) => tables(parseExpression(statement.tokens))),
  )
  NodeAssert.equal(candidates.length, 1, 'Expected one assistant Table program')
  const [headers, body] = candidates[0].args
  NodeAssert.deepEqual(cells(headers), columns, 'Table columns differ')
  NodeAssert.equal(body.k, 'Arr', 'Table rows must be an array')
  NodeAssert.deepEqual(body.els.map(cells), rows, 'Table must contain all nine expected cells')
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  await assertTable(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')))

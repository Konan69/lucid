import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import { root } from './process.mjs'

const require = NodeModule.createRequire(root + '/packages/agent/runtime/package.json')
const { createParser, createStore, evaluateRoot } = await import(
  require.resolve('@openuidev/lang-core')
)
/** The library schema the model is prompted with; `apps/web` generates it from its own library
 * (`pnpm --filter @vivid/web parts`), so this parser knows exactly the parts a client draws. */
const spec = JSON.parse(
  await NodeFSP.readFile(root + '/packages/agent/runtime/src/agents/parts.json', 'utf8'),
)
const parser = createParser(spec.schema, 'Col')
const columns = ['Project', 'Hours', 'Owner']
const rows = [
  ['Research', '4', 'Ada'],
  ['Writing', '3', 'Ben'],
  ['Review', '2', 'Cai'],
]

/** Every Table element in an evaluated tree, wherever a prop holds it. */
function tables(node) {
  if (Array.isArray(node)) return node.flatMap(tables)
  if (node === null || node === undefined || node.type !== 'element') return []
  return [
    ...(node.typeName === 'Table' ? [node] : []),
    ...Object.values(node.props).flatMap(tables),
  ]
}

/**
 * Evaluate one program the way a client first draws it: OpenUI's parser with the shipped library
 * schema, its `$state` defaults, then `evaluateRoot`. Rows a display computes (an `@Each` over a
 * filtered list, 29 October 2026) therefore count as the cells a Person sees on first draw.
 */
function drawn(program) {
  const result = parser.parse(program)
  NodeAssert.equal(result.meta.incomplete, false, 'Assistant openui-lang program is incomplete')
  const store = createStore()
  store.initialize(result.stateDeclarations, {})
  const ctx = { getState: (name) => store.get(name), resolveRef: () => null }
  return tables(evaluateRoot(result, { ctx, library: { components: {} }, store }))
}

/** Cells must be strings or numbers after evaluation; a component cell is not one of these rows. */
function cells(row) {
  NodeAssert.ok(Array.isArray(row), 'Table columns and rows must be arrays')
  return row.map((cell) => {
    NodeAssert.ok(
      cell === String(cell) || Number.isFinite(cell),
      'Table cell must be text or a number',
    )
    return String(cell)
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
  const candidates = programs.flatMap(drawn)
  NodeAssert.equal(candidates.length, 1, 'Expected one assistant Table program')
  const { props } = candidates[0]
  NodeAssert.deepEqual(cells(props.columns), columns, 'Table columns differ')
  NodeAssert.ok(Array.isArray(props.rows), 'Table rows must be an array')
  NodeAssert.deepEqual(props.rows.map(cells), rows, 'Table must contain all nine expected cells')
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  await assertTable(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')))

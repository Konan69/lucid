import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { Result, Schema } from 'effect'
import { deadCodeRatchets } from './gate/ratchets.mjs'
import { parseSource, walk, sourcePositions, isStringLiteral } from './syntax.mjs'

/** Read the actual Rpc.make declarations and the group that publishes them. */
function catalogue(file, source) {
  const declarations = new Map()
  const published = new Set()
  const position = sourcePositions(source)
  walk(parseSource(file, source), (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init !== null &&
      node.init.type === 'CallExpression' &&
      memberName(node.init.callee) === 'make' &&
      node.init.callee.object.name === 'Rpc'
    ) {
      const argument = node.init.arguments[0]
      if (isStringLiteral(argument))
        declarations.set(node.id.name, {
          name: argument.value,
          file,
          line: position(node.start).line,
        })
    }
    if (
      node.type === 'CallExpression' &&
      memberName(node.callee) === 'make' &&
      node.callee.object.name === 'RpcGroup'
    )
      for (const argument of node.arguments) published.add(argument.name)
  })
  if (published.size === 0) throw new Error('rpccallers: no published RPC procedures found')
  return [...published].map((name) => {
    const declaration = declarations.get(name)
    if (declaration === undefined) throw new Error(`rpccallers: unresolved procedure ${name}`)
    return declaration
  })
}

/** Generated clients use PascalCase members, directly or through scope.client and quoted access. */
function memberName(node) {
  if (node.type !== 'MemberExpression') return undefined
  if (!node.computed) return node.property.name
  return isStringLiteral(node.property) ? node.property.value : undefined
}

/** A name in prose, a handler, or a test cannot satisfy the production caller requirement. */
export function uncalledProcedures(root) {
  const file = 'packages/contracts/src/rpc.ts'
  const procedures = catalogue(file, NodeFS.readFileSync(NodePath.join(root, file), 'utf8'))
  const files = NodeChildProcess.execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0')
  const called = new Set()
  for (const path of new Set(files)) {
    if (!/^(apps|packages)\/.*\.[cm]?[jt]sx?$/u.test(path)) continue
    if (/^(apps\/server|packages\/contracts)\//u.test(path)) continue
    if (/(?:^|\/)(?:tests|__fixtures__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) continue
    walk(parseSource(path, NodeFS.readFileSync(NodePath.join(root, path), 'utf8')), (node) => {
      if (node.type !== 'CallExpression') return
      const name = memberName(node.callee)
      if (name !== undefined) called.add(name)
    })
  }
  return procedures.filter(({ name }) => !called.has(name))
}

/** A justified backlog is explicit and shrinks when the real caller lands. New names fail. */
export function checkCallers(root) {
  const uncalled = uncalledProcedures(root)
  const allowed = Result.getOrThrow(
    Schema.decodeUnknownResult(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.NonEmptyString)),
    )(NodeFS.readFileSync(NodePath.join(root, 'scripts/rpccallers.json'), 'utf8')),
  )
  const missing = new Set(uncalled.map(({ name }) => name))
  const failures = uncalled
    .filter(({ name }) => !Object.hasOwn(allowed, name))
    .map(
      ({ name, file, line }) =>
        `${file}:${line}: ${name} has no production caller outside server/contracts. Wire it up or justify it in scripts/rpccallers.json.`,
    )
  for (const [name, reason] of Object.entries(allowed)) {
    if (reason.trim().length === 0) failures.push(`${name}: a reason is required`)
    if (!missing.has(name)) failures.push(`${name}: remove the stale RPC exception`)
  }
  const ceiling = deadCodeRatchets.find((entry) => entry.plugin === 'rpc').ceiling
  if (uncalled.length !== ceiling)
    failures.push(
      `rpc/uncalled: ${uncalled.length} findings; ceiling ${ceiling}. Wire up new procedures; lower scripts/gate/ratchets.mjs when callers land.`,
    )
  return { uncalled, failures }
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { uncalled, failures } = checkCallers(process.cwd())
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  process.stdout.write(
    `rpccallers: ${uncalled.length} uncalled procedures, ${failures.length} violations\n`,
  )
  process.exitCode = failures.length === 0 ? 0 : 1
}

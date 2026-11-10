import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import { parseSource, walk } from '../syntax.mjs'
import { deadCodeRatchets } from './ratchets.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..', '..')
const contractsPackage = /^@vivid\/contracts(?:\/([\w-]+))?$/u
/** The two separately deployed sides of the wire: the server and the Person's cell runtime. */
const sides = ['apps/server/src', 'packages/agent/runtime/src']

/**
 * The contracts source writes `./identity.js` for `./identity.ts`, as TypeScript's module
 * resolution expects. Node strips the types but resolves the name as written, so a `.js` that is
 * absent is retried as its `.ts`. Registered once, before the first contracts import.
 */
let hooked = false
const hookContracts = () => {
  if (hooked) return
  hooked = true
  NodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (failure) {
        if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw failure
        return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context)
      }
    },
  })
}

const ContractsManifest = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) })
const decodeContractsManifest = Schema.decodeUnknownSync(Schema.fromJsonString(ContractsManifest))

/** The contracts package's export map: `.` and each subpath to its source file. */
const contractExports = (directory) =>
  decodeContractsManifest(
    NodeFS.readFileSync(NodePath.join(directory, 'packages/contracts/package.json'), 'utf8'),
  ).exports

/** Loads one `@vivid/contracts` entry by its export map, the way the apps resolve it. */
async function loadEntry(directory, subpath) {
  hookContracts()
  const file = contractExports(directory)[subpath === undefined ? '.' : `./${subpath}`]
  return import(NodeURL.pathToFileURL(NodePath.join(directory, 'packages/contracts', file)).href)
}

/** Every value (not `import type`) one source file imports from `@vivid/contracts`. */
export function contractImports(file, source) {
  const found = []
  walk(parseSource(file, source), (node) => {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') return
    const entry = contractsPackage.exec(node.source.value)
    if (entry === null) return
    for (const specifier of node.specifiers)
      if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
        found.push({ subpath: entry[1], name: specifier.imported.name, file })
  })
  return found
}

/** Every object reachable from a schema's AST, so a schema nested in a registered one counts. */
const reachable = (schemas) => {
  const seen = new Set()
  const visit = (value) => {
    if (!Predicate.isObject(value) || seen.has(value)) return
    seen.add(value)
    Object.values(value).forEach(visit)
  }
  schemas.forEach((schema) => visit(schema.ast))
  return seen
}

/**
 * The shared schemas the fingerprint does not cover. `shared` holds each value both sides import,
 * with where each side imports it. A value that is not a Schema (a helper, a constant) is not
 * wire. A Schema is covered when it is a value of `registry`, or when its AST is part of one that
 * is: an id inside a registered body changes the body's hash, so it need not be listed itself.
 */
export function unregisteredWireSchemas(shared, registry) {
  const registered = Object.values(registry)
  const inside = reachable(registered)
  return shared.filter(
    ({ value }) => Schema.isSchema(value) && !registered.includes(value) && !inside.has(value.ast),
  )
}

/** The fingerprint's registry, or none at all before `packages/contracts/src/fingerprint.ts` exists. */
async function wireRegistry(directory) {
  if (contractExports(directory)['./fingerprint'] === undefined) return {}
  const fingerprint = await loadEntry(directory, 'fingerprint')
  if (fingerprint.wireSchemas === undefined)
    throw new Error('@vivid/contracts/fingerprint must export wireSchemas')
  return fingerprint.wireSchemas
}

/** The values both sides import, each with one importing file per side, keyed by the value. */
async function sharedValues(directory) {
  const tracked = NodeChildProcess.execFileSync('git', ['ls-files', '-z', ...sides], {
    cwd: directory,
    encoding: 'utf8',
  })
  const files = tracked
    .split('\0')
    .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$|\/tests\//u.test(file))
  const bySide = sides.map(() => new Map())
  for (const file of files) {
    const side = bySide[sides.findIndex((prefix) => file.startsWith(`${prefix}/`))]
    const source = NodeFS.readFileSync(NodePath.join(directory, file), 'utf8')
    for (const { subpath, name } of contractImports(file, source)) {
      const value = (await loadEntry(directory, subpath))[name]
      if (!side.has(value)) side.set(value, { name, file })
    }
  }
  const [server, cell] = bySide
  return [...server].flatMap(([value, use]) =>
    cell.has(value)
      ? [{ value, name: use.name, server: use.file, cell: cell.get(value).file }]
      : [],
  )
}

/** One finding's line: the schema, where each side imports it, and the fix. */
export const wireFinding = ({ name, server, cell }) =>
  `${name}: crosses the server <-> cell wire (${server}, ${cell}) and is not in wireSchemas (packages/contracts/src/fingerprint.ts), so a Worker built from another version of it passes the fingerprint. Add it to wireSchemas, or register a schema that contains it.`

async function checkWire(directory) {
  return unregisteredWireSchemas(await sharedValues(directory), await wireRegistry(directory))
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const unregistered = await checkWire(root)
  const ceiling = deadCodeRatchets.find((entry) => entry.plugin === 'wire').ceiling
  if (unregistered.length !== ceiling) {
    unregistered.forEach((entry) => process.stderr.write(`${wireFinding(entry)}\n`))
    process.stderr.write(
      `wire/unregistered: ${unregistered.length} findings; ceiling ${ceiling}. Register new ones; lower scripts/gate/ratchets.mjs when one is registered.\n`,
    )
    process.exitCode = 1
  }
}

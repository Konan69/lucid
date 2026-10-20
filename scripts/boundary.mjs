import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

/**
 * `vivid/no-cross-package-import`: a relative import may not leave the package that holds the file.
 *
 * Every workspace package is a boundary with a name and, when other packages may read it, an
 * `exports` map. A relative path that climbs out of one package and into another skips both: the
 * importer takes no dependency, the build graph and Turbo's hashes do not see the edge, and the
 * file reached is internal by definition. Agents copy the nearest example, so one such import
 * became 26 (2 in production: the phone's Library reached into the web app's `data/library.ts`;
 * 24 in tests reaching runtime tools and the server's test database).
 *
 * The rule resolves each relative specifier against the importing file and walks up to the nearest
 * `package.json` on both sides; the packages differ, so the import crossed. It replaces the regex
 * that knew two package names (`client-runtime`, `contracts`) and missed every other package.
 * Prototype: `proto/boundary/plugin.mjs` on branch `proto/agent-friendly` (581a0086).
 */

/** The part of a manifest that names the package and says what it lets others import. */
const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  exports: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
  ),
})
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))

/**
 * A package as the rule names it. An app declares `"exports": {}`: nothing may import it, so the
 * fix for reaching into one is always to move the code, never to export it.
 */
const Owner = Schema.TaggedUnion({
  Package: { directory: Schema.String, name: Schema.String },
  App: { directory: Schema.String, name: Schema.String },
})

/** Owners by directory, shared by every file one lint worker visits; a walk stops at a cached one. */
const owners = new Map()

/**
 * Reads the manifest in `directory`. A manifest that is not JSON or has no name still marks a
 * package boundary for pnpm and Node, so it is named by its directory rather than ignored.
 */
const readOwner = (directory, manifestPath) => {
  const manifest = decodeManifest(NodeFS.readFileSync(manifestPath, 'utf8'))
  const name = Option.match(manifest, {
    onNone: () => directory,
    onSome: (decoded) => (decoded.name === undefined ? directory : decoded.name),
  })
  const exportsNothing = Option.match(manifest, {
    onNone: () => false,
    onSome: (decoded) =>
      decoded.exports !== undefined &&
      !Predicate.isString(decoded.exports) &&
      Object.keys(decoded.exports).length === 0,
  })
  return exportsNothing
    ? Owner.cases.App.make({ directory, name })
    : Owner.cases.Package.make({ directory, name })
}

/** The package that holds `start`: the nearest directory at or above it with a `package.json`. */
const ownerOf = (start) => {
  const visited = []
  let directory = start
  while (directory !== NodePath.dirname(directory)) {
    const known = owners.get(directory)
    if (known !== undefined) return remember(visited, Option.some(known))
    visited.push(directory)
    const manifestPath = NodePath.join(directory, 'package.json')
    if (NodeFS.existsSync(manifestPath)) {
      return remember(visited, Option.some(readOwner(directory, manifestPath)))
    }
    directory = NodePath.dirname(directory)
  }
  return Option.none()
}

/** Caches the answer for every directory the walk passed through, so siblings stop at once. */
const remember = (visited, owner) => {
  if (Option.isSome(owner)) for (const directory of visited) owners.set(directory, owner.value)
  return owner
}

/** What to do instead, by what kind of package was reached. */
const fixFor = Owner.match({
  App: ({ name }) =>
    `${name} exports nothing. Import it through a package both depend on (packages/client/state for client behaviour, packages/contracts for wire shapes): move the shared code there and import it by name.`,
  Package: ({ name }) =>
    `Import it by name through "${name}"'s package.json "exports" (add the entry and a dependency if they are missing), or through a package both depend on (packages/client/state).`,
})

/** A specifier as a path on disk: a bundler query (`?raw`) or fragment names the same file. */
const specifierPath = (specifier) => specifier.replace(/[?#].*$/u, '')

/** Reports `source` when it is a relative specifier whose target is in another package. */
const check = (context, report, source) => {
  if (source === null || source === undefined || source.type !== 'Literal') return
  if (!Predicate.isString(source.value) || !source.value.startsWith('.')) return
  const from = ownerOf(NodePath.dirname(context.filename))
  const target = NodePath.resolve(NodePath.dirname(context.filename), specifierPath(source.value))
  const to = ownerOf(target)
  if (Option.isNone(from) || Option.isNone(to)) return
  if (from.value.directory === to.value.directory) return
  report(source, { from: from.value.name, to: to.value.name, fix: fixFor(to.value) })
}

/** True for `require('...')` with one literal argument, the CommonJS form of an import. */
const isRequire = (node) =>
  node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1

export const noCrossPackageImport = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep every relative import inside the package that holds the file.' },
    schema: [],
    messages: { crossed: '{{from}} reaches into {{to}} by relative path. {{fix}}' },
  },
  create(context) {
    const report = (node, data) => context.report({ node, messageId: 'crossed', data })
    return {
      ImportDeclaration: (node) => check(context, report, node.source),
      ExportNamedDeclaration: (node) => check(context, report, node.source),
      ExportAllDeclaration: (node) => check(context, report, node.source),
      ImportExpression: (node) => check(context, report, node.source),
      CallExpression: (node) => {
        if (isRequire(node)) check(context, report, node.arguments[0])
      },
    }
  },
}

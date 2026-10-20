#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import ts from 'typescript'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

const isString = Schema.is(Schema.String)
const strings = Schema.Array(Schema.String)
const configSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  include: Schema.optionalKey(strings),
  files: Schema.optionalKey(strings),
  ignorePatterns: Schema.optionalKey(strings),
  $schema: Schema.optionalKey(Schema.String),
  extends: Schema.optionalKey(Schema.Union([Schema.String, strings])),
  references: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
  tasks: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ inputs: Schema.optionalKey(strings) })),
  ),
  overrides: Schema.optionalKey(
    Schema.Array(Schema.Struct({ files: strings, excludeFiles: Schema.optionalKey(strings) })),
  ),
  jsPlugins: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.String, Schema.Struct({ specifier: Schema.String })])),
  ),
  settings: Schema.optionalKey(
    Schema.Struct({
      tailwindcss: Schema.optionalKey(
        Schema.Struct({
          entryPoint: Schema.Array(Schema.Struct({ files: Schema.String, use: Schema.String })),
        }),
      ),
    }),
  ),
})
const reason = Schema.String.check(Schema.isPattern(/\S/))
const declarationsSchema = Schema.Struct({
  generated: Schema.Array(Schema.Struct({ path: Schema.String, reason })),
  empty: Schema.Array(Schema.Struct({ owner: Schema.String, path: Schema.String, reason })),
  examples: Schema.Array(Schema.Struct({ owner: Schema.String, paths: strings, reason })),
})

/** Malformed policy input must fail with its owner, without echoing possibly private values. */
function decode(schema, input, owner) {
  const result = Schema.decodeUnknownResult(schema)(input)
  if (Result.isFailure(result)) throw new Error(`${owner}: invalid reference configuration`)
  return result.success
}

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')

/** Git supplies source identity, so local generated files can never make a stale reference pass. */
export function repository(directory, revision) {
  const args =
    revision === undefined ? ['ls-files', '-z'] : ['ls-tree', '-rz', '--name-only', revision]
  const files = NodeChildProcess.execFileSync('git', args, { cwd: directory, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  return {
    files,
    read(file) {
      return revision === undefined
        ? NodeFS.readFileSync(NodePath.join(directory, file), 'utf8')
        : NodeChildProcess.execFileSync('git', ['show', `${revision}:${file}`], {
            cwd: directory,
            encoding: 'utf8',
            maxBuffer: 1 << 24,
          })
    },
  }
}

/** Configs permit JSON comments. TypeScript's parser preserves strings containing comment syntax. */
function config(tree, file) {
  const parsed = ts.parseConfigFileTextToJson(file, tree.read(file))
  if (parsed.error !== undefined) throw new Error(`${file}: invalid JSON configuration`)
  return decode(configSchema, parsed.config, file)
}

/** A directory reference names tracked descendants; glob matching uses Node's brace-aware matcher. */
function matches(files, pattern) {
  if (files.includes(pattern) || files.some((file) => file.startsWith(`${pattern}/`))) return true
  if (!/[*?{[]/.test(pattern)) return false
  return files.some((file) => NodePath.matchesGlob(file, pattern))
}

/** Exact owner and reference pairs prevent an exception in one document from hiding another's typo. */
function exceptionFor(entries, reference) {
  return entries.find((entry) => entry.owner === reference.owner && entry.path === reference.path)
}

/** Paths in prose are repository-root paths or document-relative links; code fences are examples. */
function proseReferences(tree, owner) {
  const text = tree.read(owner).replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '')
  const references = []
  for (const match of text.matchAll(
    /`((?:\.{1,2}\/|\.agents\/|apps\/|packages\/|scripts\/|docs\/|infra\/|tools\/|refs\/|artifacts\/|node_modules\/)[^`\s]+)`/g,
  )) {
    if (/[<>]/.test(match[1])) continue
    references.push({
      owner,
      path: match[1],
      base: /^\.{1,2}\//.test(match[1]) ? NodePath.posix.dirname(owner) : '',
      purpose: 'source',
    })
  }
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const path = match[1].split('#')[0]
    if (path === '...' || path === '' || /^(?:[a-z]+:|[~/])/i.test(path)) continue
    references.push({ owner, path, base: NodePath.posix.dirname(owner), purpose: 'source' })
  }
  return references
}

/** Exclusions also need an owner: tracked files, generated roots, or an explicit future guard. */
function lintReferences(tree) {
  const owner = '.oxlintrc.json'
  const lint = config(tree, owner)
  const references = (lint.ignorePatterns ?? []).map((path) => ({
    owner,
    path,
    base: '',
    purpose: 'scope',
  }))
  if (lint.$schema !== undefined && lint.$schema.startsWith('.')) {
    references.push({ owner, path: lint.$schema, base: '', purpose: 'source' })
  }
  for (const override of lint.overrides ?? []) {
    for (const path of [...override.files, ...(override.excludeFiles ?? [])])
      references.push({ owner, path, base: '', purpose: 'scope' })
  }
  return references.concat(lintSourceReferences(lint))
}

/** Theme entry points and local plugins are source inputs rather than inclusion scopes. */
function lintSourceReferences(lint) {
  const owner = '.oxlintrc.json'
  const references = []
  const settings = lint.settings
  const tailwind = settings === undefined ? undefined : settings.tailwindcss
  for (const entry of tailwind === undefined ? [] : tailwind.entryPoint) {
    references.push({ owner, path: entry.files, base: '', purpose: 'scope' })
    references.push({ owner, path: entry.use, base: '', purpose: 'source' })
  }
  for (const plugin of lint.jsPlugins ?? []) {
    if (!isString(plugin))
      references.push({ owner, path: plugin.specifier, base: '', purpose: 'source' })
  }
  return references
}

/** Unknown qualified tasks deliberately have no matching package, rather than resolving at root. */
function packageBases(name, packages) {
  if (name === '//') return ['']
  const pkg = packages.find((candidate) => candidate.name === name)
  return pkg === undefined ? [] : [pkg.base]
}

/** Generic Turbo tasks resolve within each package; qualified tasks resolve only in their owner. */
function turboReferences(tree) {
  const packages = tree.files
    .filter((file) => file.endsWith('/package.json') && !file.startsWith('scripts/'))
    .map((file) => ({ name: config(tree, file).name, base: NodePath.posix.dirname(file) }))
  const references = []
  for (const [task, definition] of Object.entries(config(tree, 'turbo.json').tasks)) {
    const name = task.split('#')[0]
    const bases = task.includes('#')
      ? packageBases(name, packages)
      : packages.map((pkg) => pkg.base)
    for (const path of definition.inputs ?? []) {
      if (path.startsWith('!') || path === '$TURBO_DEFAULT$') continue
      if (path.startsWith('$TURBO_ROOT$/')) {
        references.push({ owner: 'turbo.json', path, base: '', purpose: 'source' })
        continue
      }
      references.push({ owner: 'turbo.json', path, bases, purpose: 'source' })
    }
  }
  return references
}

/** Bare extends names belong to dependencies; relative includes, files and extends belong to Git. */
function typeReferences(tree, owner) {
  const parsed = config(tree, owner)
  const base = NodePath.posix.dirname(owner)
  const references = []
  for (const path of [...(parsed.include ?? []), ...(parsed.files ?? [])]) {
    references.push({ owner, path, base, purpose: 'source' })
  }
  const extensions = isString(parsed.extends) ? [parsed.extends] : (parsed.extends ?? [])
  for (const path of extensions) {
    references.push({ owner, path, base, purpose: path.startsWith('.') ? 'extends' : 'dependency' })
  }
  for (const reference of parsed.references ?? []) {
    references.push({ owner, path: reference.path, base, purpose: 'extends' })
  }
  return references
}

/** Each ingress has its own path semantics; do not apply config resolution rules to prose. */
function referencesIn(tree) {
  const references = []
  for (const file of tree.files) {
    if (
      /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file) ||
      /^(?:docs\/|\.agents\/skills\/).*\.md$/.test(file)
    ) {
      references.push(...proseReferences(tree, file))
    }
    if (/(?:^|\/)tsconfig[^/]*\.json$/.test(file)) references.push(...typeReferences(tree, file))
  }
  if (tree.files.includes('.oxlintrc.json')) references.push(...lintReferences(tree))
  if (tree.files.includes('turbo.json')) references.push(...turboReferences(tree))
  return references
}

/** Packaged configs need both a nearest manifest dependency and an exact declared upstream path. */
function dependencyResolves(tree, reference, declarations) {
  const dependency = reference.path.startsWith('@')
    ? reference.path.split('/').slice(0, 2).join('/')
    : reference.path.split('/')[0]
  let base = NodePath.posix.dirname(reference.owner)
  while (true) {
    const file = NodePath.posix.join(base, 'package.json')
    if (tree.files.includes(file)) {
      const manifest = config(tree, file)
      const declared = Object.hasOwn(
        { ...manifest.dependencies, ...manifest.devDependencies },
        dependency,
      )
      return declared && declarations.generated.some((entry) => entry.path === reference.path)
    }
    if (base === '.') return false
    base = NodePath.posix.dirname(base)
  }
}

/** A generated root grants only the declared path pattern, never every missing child under it. */
function resolves(tree, reference, declarations) {
  if (reference.path.startsWith('!')) return true
  if (reference.purpose === 'dependency') return dependencyResolves(tree, reference, declarations)
  const bases = reference.bases ?? [reference.base]
  return bases.some((base) => {
    if (base === undefined) return false
    const path = NodePath.posix
      .normalize(
        NodePath.posix.join(
          base,
          reference.path.replace(/^\$TURBO_ROOT\$\//, '').replace(/:[0-9][0-9,–-]*$/, ''),
        ),
      )
      .replace(/\/$/, '')
    if (matches(tree.files, path)) return true
    if (reference.purpose === 'extends' && matches(tree.files, `${path}.json`)) return true
    return declarations.generated.some((entry) => NodePath.matchesGlob(path, entry.path))
  })
}

/** All exemptions are reviewable data with reasons, scoped to one owner and exact reference. */
export function checkReferences(tree, input) {
  const declarations = decode(declarationsSchema, input, 'scripts/references.json')
  const findings = []
  const references = referencesIn(tree)
  for (const reference of references) {
    if (exceptionFor(declarations.empty, reference) !== undefined) {
      if (resolves(tree, reference, { ...declarations, generated: [] })) {
        findings.push(
          `${reference.owner}: ${reference.path} is no longer empty; remove its declaration`,
        )
      }
      continue
    }
    if (
      declarations.examples.some(
        (entry) => entry.owner === reference.owner && entry.paths.includes(reference.path),
      )
    )
      continue
    if (!resolves(tree, reference, declarations))
      findings.push(
        `${reference.owner}: ${reference.path} matches no tracked source or declared generated path`,
      )
  }
  return [...new Set(findings)]
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const tree = repository(root, process.argv[2])
  const file = 'scripts/references.json'
  const declarations = ts.parseConfigFileTextToJson(
    file,
    NodeFS.readFileSync(NodePath.join(root, file), 'utf8'),
  )
  if (declarations.error !== undefined) throw new Error(`${file}: invalid JSON configuration`)
  const findings = checkReferences(tree, declarations.config)
  for (const finding of findings) process.stderr.write(`${finding}\n`)
  process.stdout.write(`references: ${findings.length} stale references\n`)
  process.exitCode = findings.length === 0 ? 0 : 1
}

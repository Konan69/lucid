import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { isStringLiteral, parseSource, walk } from './syntax.mjs'
import { parseJsonc } from './jsonc.mjs'
import * as YAML from 'yaml'

const assert = NodeAssert

const Dependencies = Schema.Record(Schema.String, Schema.String)
const Manifest = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.optionalKey(Dependencies),
  optionalDependencies: Schema.optionalKey(Dependencies),
  peerDependencies: Schema.optionalKey(Dependencies),
  devDependencies: Schema.optionalKey(Dependencies),
})
const Workspace = Schema.Struct({ packages: Schema.Array(Schema.String) })
const Config = Schema.Struct({
  extends: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  references: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
})

/** Invalid policy inputs stop verification instead of silently shortening the dependency graph. */
function decode(schema, input, location) {
  const result = Schema.decodeUnknownResult(schema)(input)
  assert.ok(Result.isSuccess(result), `${location}: invalid image policy input`)
  return result.success
}

/** pnpm's declared workspace patterns are authoritative, including newly added group directories. */
function workspaceGraph(root) {
  const workspace = decode(
    Workspace,
    YAML.parse(NodeFS.readFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'utf8')),
    'pnpm-workspace.yaml',
  )
  const graph = new Map()
  for (const directory of NodeFS.globSync(workspace.packages, { cwd: root })) {
    const file = `${directory}/package.json`
    const manifest = decode(
      Schema.fromJsonString(Manifest),
      NodeFS.readFileSync(NodePath.join(root, file), 'utf8'),
      file,
    )
    assert.ok(!graph.has(manifest.name), `${file}: duplicate workspace name ${manifest.name}`)
    graph.set(manifest.name, { directory, manifest })
  }
  const manifest = decode(
    Schema.fromJsonString(Manifest),
    NodeFS.readFileSync(NodePath.join(root, 'package.json'), 'utf8'),
    'package.json',
  )
  graph.set(manifest.name, { directory: '.', manifest })
  return graph
}

/** Shipping follows production edges; installation also needs manifests for development edges. */
function closure(graph, roots, development) {
  const reached = new Set()
  const pending = [...roots]
  for (const name of pending) {
    if (reached.has(name)) continue
    const entry = graph.get(name)
    assert.notEqual(entry, undefined, `workspace package ${name} has no manifest`)
    reached.add(name)
    const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']
    if (development) sections.push('devDependencies')
    const dependencies = sections.flatMap((section) =>
      Object.entries(entry.manifest[section] ?? {}),
    )
    for (const [dependency, version] of dependencies) {
      if (version.startsWith('workspace:') || graph.has(dependency)) pending.push(dependency)
    }
  }
  return [...reached].map((name) => graph.get(name))
}

/** These images use exact pnpm selectors, optionally with dependency closure or exclusion. */
function installPackages(line, graph) {
  const selected = new Set()
  const excluded = new Set()
  const selectors = [...line.matchAll(/--filter(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g)]
  assert.ok(selectors.length > 0, 'image install must name its workspace filters')
  for (const match of selectors) {
    const selector = match[1] ?? match[2] ?? match[3]
    const negative = selector.startsWith('!')
    const name = selector.replace(/^!/, '').replace(/\.\.\.$/, '')
    assert.ok(graph.has(name), `unsupported image install filter ${selector}`)
    const packages = selector.endsWith('...')
      ? closure(graph, [name], !/--prod\b/.test(line))
      : [graph.get(name)]
    for (const entry of packages) (negative ? excluded : selected).add(entry)
  }
  return [...selected].filter((entry) => !excluded.has(entry))
}

/** A directory COPY preserves its contents but not its basename at the destination. */
function copyEntries(line) {
  const body = line.replace(/^(?:COPY|ADD)\s+/, '').replace(/--\S+\s+/g, '')
  const words = body.startsWith('[')
    ? decode(Schema.fromJsonString(Schema.Array(Schema.String)), body, 'Docker COPY')
    : body.trim().split(/\s+/)
  const destination = words.pop()
  assert.notEqual(destination, undefined, 'Docker COPY needs a destination')
  return words.map((source) => ({
    source: NodePath.posix.normalize(source),
    destination,
    multiple: words.length > 1,
  }))
}

/** Source and destination must agree: a file copied elsewhere cannot satisfy its original path. */
function covers(root, copy, required) {
  const directory = NodeFS.statSync(NodePath.join(root, copy.source)).isDirectory()
  const destination = copy.destination.replace(/^\/app\//, '')
  const target = NodePath.posix.normalize(
    directory || (!copy.multiple && !destination.endsWith('/'))
      ? destination
      : NodePath.posix.join(destination, NodePath.posix.basename(copy.source)),
  )
  if (copy.source !== target) return false
  return (
    required === copy.source ||
    (directory && (copy.source === '.' || required.startsWith(`${copy.source}/`)))
  )
}

/** Dockerignore rules apply before COPY. A later negation can restore a required input. */
function ignored(root, required) {
  const rules = NodeFS.readFileSync(NodePath.join(root, '.dockerignore'), 'utf8').split('\n')
  const ancestors = required
    .split('/')
    .map((_, index, parts) => parts.slice(0, index + 1).join('/'))
  let excluded = false
  for (const rule of rules
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))) {
    const pattern = rule.replace(/^!/, '').replace(/^\/|\/$/g, '')
    if (ancestors.some((ancestor) => NodePath.matchesGlob(ancestor, pattern)))
      excluded = !rule.startsWith('!')
  }
  return excluded
}

/** Check the image filesystem, not merely whether Dockerfile text mentions an input. */
function requireCopied(context, required, reason) {
  assert.ok(
    context.copies.some((copy) => covers(context.root, copy, required)),
    `${context.label}: COPY ${required} ${reason}`,
  )
  assert.ok(
    !ignored(context.root, required),
    `${context.label}: .dockerignore excludes ${required}`,
  )
}

function configReferences(root, file) {
  const config = decode(
    Config,
    parseJsonc(NodeFS.readFileSync(NodePath.join(root, file), 'utf8'), file),
    file,
  )
  const extended = config.extends === undefined ? [] : [config.extends].flat()
  const local = extended.filter(
    (reference) => reference.startsWith('.') || reference.startsWith('/'),
  )
  const references = (config.references ?? []).map((reference) => reference.path)
  return [...local, ...references, ...(config.files ?? [])].map((reference) => {
    let resolved = NodePath.posix.join(NodePath.posix.dirname(file), reference)
    if (reference.startsWith('/')) resolved = reference.slice(1)
    assert.ok(!resolved.startsWith('../'), `${file}: config input leaves the repository`)
    if (
      NodeFS.existsSync(NodePath.join(root, resolved)) &&
      NodeFS.statSync(NodePath.join(root, resolved)).isDirectory()
    )
      resolved = `${resolved}/tsconfig.json`
    if (!NodeFS.existsSync(NodePath.join(root, resolved)) && !resolved.endsWith('.json'))
      resolved += '.json'
    assert.ok(
      NodeFS.existsSync(NodePath.join(root, resolved)),
      `${file}: missing config input ${resolved}`,
    )
    return resolved
  })
}

/**
 * Build configs can import helpers outside their package; follow literal module edges as well.
 * Computed filesystem reads, including path.resolve or path.join followed by copyFileSync,
 * are not followed. Keep their targets inside a copied tree or add them to the Dockerfile COPY
 * and Railway watch list by hand.
 */
function moduleReferences(root, file) {
  const tree = parseSource(file, NodeFS.readFileSync(NodePath.join(root, file), 'utf8'))
  const references = []
  walk(tree, (node) => {
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    )
      references.push(node.source)
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require'
    )
      references.push(...node.arguments)
  })
  return references
    .values()
    .filter((node) => isStringLiteral(node) && node.value.startsWith('.'))
    .map((node) => {
      const relative = NodePath.posix.join(NodePath.posix.dirname(file), node.value)
      const candidates = [
        relative,
        relative.replace(/\.js$/, '.ts'),
        `${relative}.ts`,
        `${relative}.js`,
        `${relative}.cjs`,
        `${relative}.mjs`,
        `${relative}/index.ts`,
        `${relative}/index.js`,
      ]
      const resolved = candidates.find(
        (candidate) =>
          NodeFS.existsSync(NodePath.join(root, candidate)) &&
          NodeFS.statSync(NodePath.join(root, candidate)).isFile(),
      )
      assert.notEqual(resolved, undefined, `${file}: missing config module ${relative}`)
      assert.ok(!resolved.startsWith('../'), `${file}: config input leaves the repository`)
      return resolved
    })
    .toArray()
}

/** Walk every copied package's config, even packages reached only through a broad COPY. */
function requireConfigs(context, graph) {
  const pending = []
  for (const { directory } of graph.values()) {
    if (directory === '.' || !context.copies.some((copy) => covers(context.root, copy, directory)))
      continue
    pending.push(
      ...NodeFS.globSync([`${directory}/tsconfig*.json`, `${directory}/*.config.{ts,js,cjs,mjs}`], {
        cwd: context.root,
      }),
    )
  }
  const visited = new Set()
  for (const file of pending) {
    if (visited.has(file)) continue
    visited.add(file)
    requireCopied(context, file, 'because a copied package config reads it')
    const references = file.endsWith('.json')
      ? configReferences(context.root, file)
      : moduleReferences(context.root, file)
    for (const referenced of references) {
      requireCopied(context, referenced, `because ${file} reads it`)
      context.configInputs.add(referenced)
      if (/\.(json|[cm]?js|ts)$/.test(referenced) && !referenced.endsWith('.d.ts'))
        pending.push(referenced)
    }
  }
}

/** A copied workspace tree is usable only if that stage installed it and has its config inputs. */
function requireBuild(context, graph, roots) {
  for (const { directory, manifest } of closure(graph, roots, false)) {
    assert.ok(
      context.installed.has(manifest.name),
      `${context.label}: pnpm install must select ${manifest.name}`,
    )
    requireCopied(context, directory, `for production workspace package ${manifest.name}`)
  }
  requireConfigs(context, graph)
}

/** Root pnpm configuration and workspace manifests must exist before each install. */
function requireInstall(context, line, graph) {
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmfile.cjs',
    '.npmrc',
    'patches',
  ]) {
    if (NodeFS.existsSync(NodePath.join(context.root, file)))
      requireCopied(context, file, 'before pnpm install reads root configuration')
  }
  for (const { directory, manifest } of installPackages(line, graph)) {
    requireCopied(
      context,
      NodePath.posix.join(directory, 'package.json'),
      `before pnpm install for ${manifest.name}`,
    )
    context.installed.add(manifest.name)
  }
}

/** FROM inherits a snapshot of its parent, so later stages cannot repair the parent's inputs. */
function imageStage(root, label, parent) {
  const inherited = parent === undefined ? { copies: [], installed: [] } : parent
  return {
    root,
    label,
    copies: [...inherited.copies],
    installed: new Set(inherited.installed),
    configInputs: new Set(),
  }
}

/**
 * Install manifests must already exist in that stage. Build inputs follow FROM inheritance;
 * a later COPY or a COPY in an unrelated stage cannot repair an earlier install.
 * Roots name what each image promises to build, independently of its COPY instructions.
 * Config traversal follows local tsconfig extends, references, explicit files and literal module
 * imports. It does not follow computed filesystem reads, such as path.resolve or path.join with
 * copyFileSync. Keep those targets inside a copied tree or add them to the Dockerfile COPY and
 * Railway watch list by hand.
 */
export function verifyImage({ root, dockerfile, stages }) {
  const graph = workspaceGraph(root)
  const contexts = new Map()
  let context
  for (const line of dockerfile.replace(/\\\n/g, ' ').split('\n')) {
    const from = /^FROM\s+(\S+)\s+AS\s+(\S+)/i.exec(line)
    if (from !== null) {
      context = imageStage(root, from[2], contexts.get(from[1]))
      contexts.set(from[2], context)
    } else if (/^(COPY|ADD) /.test(line) && !/--from=/.test(line)) {
      assert.notEqual(context, undefined, 'COPY must belong to an image stage')
      context.copies.push(...copyEntries(line))
    } else if (/^RUN .*\bpnpm install\b/.test(line)) {
      requireInstall(context, line, graph)
    } else if (line.startsWith('RUN ') && stages[context.label] !== undefined) {
      requireBuild(context, graph, stages[context.label])
    }
  }
  const inputs = new Set()
  for (const [stage, roots] of Object.entries(stages)) {
    const build = contexts.get(stage)
    assert.notEqual(build, undefined, `image must declare its ${stage} stage`)
    requireBuild(build, graph, roots)
    for (const file of build.configInputs) inputs.add(file)
  }
  return [...inputs]
}

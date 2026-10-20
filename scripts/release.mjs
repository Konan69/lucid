#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as YAML from 'yaml'

class ReleaseInputFailure extends Schema.TaggedError()(
  'ReleaseInputFailure',
  {
    location: Schema.String,
  },
  { title: 'Release input failure' },
) {}
class ArchiveFailure extends Schema.TaggedError()(
  'ArchiveFailure',
  {
    dependency: Schema.String,
  },
  { title: 'Archive failure' },
) {}

const isString = Schema.is(Schema.String)
const Strings = Schema.Record(Schema.String, Schema.String)
const Edges = Schema.Struct({
  dependencies: Schema.optionalKey(Strings),
  optionalDependencies: Schema.optionalKey(Strings),
})
const Importer = Schema.Struct({
  dependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
  optionalDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
})
const Lockfile = Schema.Struct({
  lockfileVersion: Schema.Literal('9.0'),
  importers: Schema.Record(Schema.String, Importer),
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({
      resolution: Schema.Struct({
        integrity: Schema.optionalKey(Schema.String),
        tarball: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
  snapshots: Schema.Record(Schema.String, Edges),
})
const Manifest = Schema.Record(Schema.String, Schema.Json)
const Expo = Schema.Struct({
  expo: Schema.StructWithRest(
    Schema.Struct({
      version: Schema.String,
      runtimeVersion: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)]),
    }),
    [Schema.Record(Schema.String, Schema.Json)],
  ),
})

/** Untrusted config is decoded once; diagnostics name the file, never rejected contents. */
function decode(schema, value, location) {
  const result = Schema.decodeUnknownResult(schema)(value)
  if (Result.isFailure(result)) throw new ReleaseInputFailure({ location })
  return result.success
}

/** Git reads committed objects even when a hook runs with a dirty working tree. */
function git(root, args, encoding = 'utf8') {
  const result = NodeChildProcess.spawnSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: 1 << 28,
  })
  if (result.status !== 0) throw new ReleaseInputFailure({ location: 'git revision or file' })
  return result.stdout
}

/** pnpm 12 prepends a separate tool lock document; the phone lives in the workspace document. */
function lockfile(root, revision) {
  const documents = YAML.parseAllDocuments(git(root, ['show', `${revision}:pnpm-lock.yaml`]))
  for (const document of documents) {
    if (document.errors.length > 0)
      throw new ReleaseInputFailure({ location: 'pnpm-lock.yaml syntax' })
  }
  const workspace = documents.find((document) => document.hasIn(['importers', 'apps/mobile']))
  if (workspace === undefined)
    throw new ReleaseInputFailure({ location: 'pnpm-lock.yaml phone importer' })
  return decode(Lockfile, workspace.toJS(), 'pnpm-lock.yaml workspace graph')
}

/** Only production edges ship; absent optional edges differ from an unresolved required snapshot. */
function edges(record) {
  return Object.entries({ ...record.dependencies, ...record.optionalDependencies })
}

/** Strip peer and patch contexts for archive identity, retaining them while traversing snapshots. */
function archiveKey(key) {
  return key.split('(')[0]
}

/** A graph per revision sees removed dependencies and ignores unrelated server patches and upgrades. */
function phoneGraph(lock) {
  const workspaces = new Set()
  const packages = new Map()
  const visited = new Set()
  const queue = [{ kind: 'workspace', key: 'apps/mobile' }]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    const identity = `${current.kind}:${current.key}`
    if (visited.has(identity)) continue
    visited.add(identity)
    const record =
      current.kind === 'workspace' ? lock.importers[current.key] : lock.snapshots[current.key]
    if (record === undefined)
      throw new ReleaseInputFailure({ location: `lock snapshot ${current.key}` })
    if (current.kind === 'workspace') workspaces.add(current.key)
    else {
      const key = archiveKey(current.key)
      const metadata = lock.packages[key]
      if (metadata === undefined) throw new ReleaseInputFailure({ location: `lock package ${key}` })
      packages.set(key, metadata.resolution)
    }
    for (const [name, edge] of edges(record)) {
      const version = current.kind === 'workspace' ? edge.version : edge
      queue.push(resolveEdge(lock, current, name, version))
    }
  }
  return { workspaces, packages }
}

/** Workspace links are relative to their importer; registry aliases name their own snapshot. */
function resolveEdge(lock, current, name, version) {
  if (version.startsWith('link:')) {
    return {
      kind: 'workspace',
      key: NodePath.posix.normalize(NodePath.posix.join(current.key, version.slice(5))),
    }
  }
  const named = `${name}@${version}`
  if (lock.snapshots[named] !== undefined) return { kind: 'package', key: named }
  if (lock.snapshots[version] !== undefined) return { kind: 'package', key: version }
  throw new ReleaseInputFailure({ location: `unresolved phone dependency ${name}` })
}

/** Tar is read without extraction; version-pinned archives determine native capability, never node_modules. */
function nativeArchive(bytes, key) {
  const result = NodeChildProcess.spawnSync('tar', ['-tzf', '-'], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  if (result.status !== 0) throw new ArchiveFailure({ dependency: key })
  return result.stdout
    .split('\n')
    .some(
      (file) =>
        /(?:^|\/)(?:ios|android)\//u.test(file) ||
        /(?:^|\/)(?:app\.plugin\.[cm]?js|expo-module\.config\.json|[^/]+\.podspec)$/u.test(file),
    )
}

/** Integrity binds fetched bytes to this revision's lock. A registry response alone is not proof. */
function verifyArchive(bytes, resolution, key) {
  if (resolution.integrity === undefined) throw new ArchiveFailure({ dependency: key })
  const [algorithm, digest] = resolution.integrity.split('-')
  if (!['sha512', 'sha256', 'sha1'].includes(algorithm))
    throw new ArchiveFailure({ dependency: key })
  const actual = NodeCrypto.createHash(algorithm).update(bytes).digest('base64')
  if (actual !== digest) throw new ArchiveFailure({ dependency: key })
  return nativeArchive(bytes, key)
}

/** Local vendored archives come from Git; remote archives use the exact locked version and integrity. */
const inspectArchive = Effect.fn('release.inspectArchive')(
  function* (root, revision, key, resolution) {
    const tarball = resolution.tarball
    if (tarball !== undefined && tarball.startsWith('file:')) {
      return verifyArchive(
        git(root, ['show', `${revision}:${tarball.slice(5)}`], null),
        resolution,
        key,
      )
    }
    const separator = key.lastIndexOf('@')
    const name = key.slice(0, separator)
    const version = key.slice(separator + 1)
    const url =
      tarball === undefined
        ? `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
        : tarball
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { signal: AbortSignal.timeout(60_000) }),
      catch: () => new ArchiveFailure({ dependency: key }),
    })
    if (!response.ok) return yield* Effect.fail(new ArchiveFailure({ dependency: key }))
    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: () => new ArchiveFailure({ dependency: key }),
    })
    return verifyArchive(Buffer.from(bytes), resolution, key)
  },
)

/** Resolution identity omits peer hashes, so a JS peer upgrade does not pretend native bytes changed. */
function differentPackages(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)),
  )
}

/** Strict three-part versions compare numerically, including carries such as 0.3.9 to 0.3.10. */
function rises(before, after) {
  if (!isString(before) || !isString(after)) return false
  if (!/^\d+\.\d+\.\d+$/u.test(before) || !/^\d+\.\d+\.\d+$/u.test(after)) return false
  const previous = before.split('.').map(Number)
  const next = after.split('.').map(Number)
  const differing = next.findIndex((part, index) => part !== previous[index])
  return differing !== -1 && next[differing] > previous[differing]
}

/** Version fields do not change the native config. Every other Expo field can affect a binary. */
function nativeConfig(expo) {
  const { version: _version, runtimeVersion: _runtimeVersion, ...config } = expo
  return config
}

/** Native package options control linked libraries; dependency bytes are compared through the lock graph. */
function nativeManifest(manifest) {
  const {
    dependencies: _dependencies,
    optionalDependencies: _optionalDependencies,
    peerDependencies: _peerDependencies,
    devDependencies: _devDependencies,
    scripts: _scripts,
    name: _name,
    version: _version,
    main: _main,
    type: _type,
    private: _private,
    ...config
  } = manifest
  return config
}

/** Tests, docs and editor/build-check configuration do not reach the installed phone. */
function shippedFile(file, workspaces) {
  if (
    /(?:\.test\.[cm]?[jt]sx?$|\.md$|\/__tests__\/|\/tests\/|\/tsconfig[^/]*\.json$|\/vitest\.config\.)/u.test(
      file,
    )
  )
    return false
  if (file.startsWith('apps/mobile/')) {
    return /^(?:src|assets|vendor|modules|plugins|ios|android|deps)\/|^(?:index\.[jt]s|app\.(?:json|config\.[cm]?[jt]s)|metro\.config\.[cm]?js|babel\.config\.[cm]?js|package\.json)$/u.test(
      file.slice(12),
    )
  }
  return [...workspaces].some((directory) => file.startsWith(`${directory}/`))
}

/** Native paths also include icon bytes and local config plugins that Expo embeds during prebuild. */
function nativeFile(file) {
  return /^apps\/mobile\/(?:ios\/|android\/|plugins\/|modules\/|app\.config\.|assets\/icon\.)/u.test(
    file,
  )
}

/** Parse only the publisher's literal compatibility list. Never execute a historical publisher. */
function olderRuntimes(root, revision) {
  const publisher = git(root, ['show', `${revision}:apps/mobile/scripts/publish.mjs`])
  const match = /^const ALSO_RUNS_ON = (\[[\s\S]*?\])/mu.exec(publisher)
  if (match === null)
    throw new ReleaseInputFailure({ location: 'publish.mjs ALSO_RUNS_ON literal' })
  return decode(Schema.Array(Schema.String), YAML.parse(match[1]), 'publish.mjs ALSO_RUNS_ON')
}

/** Both old and new graphs matter when a native dependency or its patch disappears. */
const nativeChanges = Effect.fn('release.nativeChanges')(function* (root, snapshots, changed) {
  const [before, after] = snapshots
  const native = changed.filter(nativeFile)
  if (!NodeUtil.isDeepStrictEqual(nativeConfig(before.expo), nativeConfig(after.expo)))
    native.push('apps/mobile/app.json native config')
  if (!NodeUtil.isDeepStrictEqual(nativeManifest(before.manifest), nativeManifest(after.manifest)))
    native.push('apps/mobile/package.json native options')
  const dependencies = new Set(differentPackages(before.graph.packages, after.graph.packages))
  for (const key of changedPatches(root, snapshots)) dependencies.add(key)
  for (const snapshot of snapshots) {
    for (const [key, resolution] of snapshot.graph.packages) {
      if (resolution.tarball !== undefined && changed.includes(resolution.tarball.slice(5)))
        dependencies.add(key)
    }
  }
  const inspected = yield* Effect.forEach(
    [...dependencies],
    (key) => inspectDependency(root, snapshots, key),
    { concurrency: 4 },
  )
  native.push(...inspected.filter((entry) => entry.native).map((entry) => entry.key))
  return native
})

/** Archive GETs are read-only. Retry transient availability twice; integrity defects never retry. */
const inspectDependency = Effect.fn('release.inspectDependency')(function* (root, snapshots, key) {
  for (const snapshot of snapshots) {
    const resolution = snapshot.graph.packages.get(key)
    if (resolution === undefined) continue
    if (
      yield* inspectArchive(root, snapshot.revision, key, resolution).pipe(
        Effect.retry({ times: 2 }),
      )
    )
      return { key, native: true }
  }
  return { key, native: false }
})

/** Compare only patches applied to a phone dependency, including removal and changed patch bytes. */
function changedPatches(root, snapshots) {
  const [before, after] = snapshots
  const changed = new Set()
  for (const snapshot of snapshots) {
    for (const [selector, path] of Object.entries(snapshot.patches)) {
      if (!snapshot.graph.packages.has(selector)) continue
      const other = snapshot === before ? after : before
      if (other.patches[selector] !== path || !other.graph.packages.has(selector))
        changed.add(selector)
      else if (
        git(root, ['show', `${snapshot.revision}:${path}`]) !==
        git(root, ['show', `${other.revision}:${path}`])
      )
        changed.add(selector)
    }
  }
  return changed
}

/** A snapshot holds the config and dependency closure of one committed revision. */
function readSnapshot(root, revision) {
  const expo = decode(
    Schema.fromJsonString(Expo),
    git(root, ['show', `${revision}:apps/mobile/app.json`]),
    'apps/mobile/app.json',
  ).expo
  const graph = phoneGraph(lockfile(root, revision))
  const workspace = YAML.parse(git(root, ['show', `${revision}:pnpm-workspace.yaml`]))
  const patches = decode(
    Schema.Struct({ patchedDependencies: Schema.optionalKey(Strings) }),
    workspace,
    'pnpm-workspace.yaml patches',
  )
  return {
    revision,
    expo,
    manifest: decode(
      Schema.fromJsonString(Manifest),
      git(root, ['show', `${revision}:apps/mobile/package.json`]),
      'apps/mobile/package.json',
    ),
    graph,
    patches: patches.patchedDependencies === undefined ? {} : patches.patchedDependencies,
  }
}

/** Compare the whole push with the published release, allowing a later commit to supply the bump. */
const checkRelease = Effect.fn('release.checkRelease')(function* (root, base, head) {
  const before = readSnapshot(root, base)
  const after = readSnapshot(root, head)
  const errors = []
  if (!isString(after.expo.runtimeVersion)) {
    return [
      'apps/mobile/app.json runtimeVersion must be a literal string; appVersion policy strands installed phones when version rises.',
    ]
  }
  const changed = git(root, ['diff', '--no-renames', '--name-only', '-z', base, head])
    .split('\0')
    .filter(Boolean)
  const workspaces = new Set([...before.graph.workspaces, ...after.graph.workspaces])
  const shipped = changed.filter((file) => shippedFile(file, workspaces))
  const dependencies = [
    ...differentPackages(before.graph.packages, after.graph.packages),
    ...changedPatches(root, [before, after]),
  ]
  const native = yield* nativeChanges(root, [before, after], changed)
  if (
    (shipped.length > 0 || dependencies.length > 0) &&
    !rises(before.expo.version, after.expo.version)
  ) {
    errors.push(
      'Phone inputs changed; raise version in apps/mobile/app.json above the published version.',
    )
  }
  if (native.length > 0) {
    if (!rises(before.expo.runtimeVersion, after.expo.runtimeVersion))
      errors.push(
        `Native inputs changed (${native.slice(0, 3).join(', ')}); raise runtimeVersion in apps/mobile/app.json.`,
      )
    if (olderRuntimes(root, head).length > 0)
      errors.push('Native inputs changed; empty ALSO_RUNS_ON in apps/mobile/scripts/publish.mjs.')
  } else if (after.expo.runtimeVersion !== before.expo.runtimeVersion) {
    errors.push(
      'JavaScript-only release; keep runtimeVersion unchanged in apps/mobile/app.json so installed phones keep receiving updates.',
    )
  }
  return errors
})

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  const root = process.cwd()
  const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2)
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- This file is the pre-push executable and owns its CLI runtime.
  const result = await Effect.runPromise(Effect.result(checkRelease(root, base, head)))
  if (Result.isFailure(result)) {
    process.stderr.write(
      `phone release check could not inspect ${result.failure.dependency} (${result.failure._tag}); its locked archive must be available.\n`,
    )
    process.exitCode = 1
  } else {
    for (const error of result.success) process.stderr.write(`${error}\n`)
    process.exitCode = result.success.length === 0 ? 0 : 1
    if (result.success.length === 0)
      process.stdout.write(`phone release passed (${base}..${head})\n`)
  }
}

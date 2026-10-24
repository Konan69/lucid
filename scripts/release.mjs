#!/usr/bin/env node
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import * as Effect from 'effect/Effect'
import * as Duration from 'effect/Duration'
import * as Stream from 'effect/Stream'
import * as Result from 'effect/Result'
import * as Predicate from 'effect/Predicate'
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

class ArchiveAvailabilityFailure extends Schema.TaggedError()(
  'ArchiveAvailabilityFailure',
  { dependency: Schema.String },
  { title: 'Archive availability failure' },
) {}

class ArchiveTransferIdle extends Schema.TaggedError()(
  'ArchiveTransferIdle',
  { dependency: Schema.String },
  { title: 'Archive transfer idle' },
) {}

/** The registry cannot push readiness before headers or bytes. Source: unmeasured.
 * Sixty seconds without headers or another body chunk fails this read-only attempt with
 * ArchiveTransferIdle. Every chunk resets the idle bound; total transfer time is unlimited. */
const archiveIdle = Duration.seconds(60)

/** Locked GETs are idempotent. Source: unmeasured. Two retries bound repeated transient
 * availability failures or idle transfers; integrity and permanent HTTP failures fail immediately. */
const archiveAvailabilityRetries = 2

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

const decodeStoreIdentity = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ key: Schema.String })),
)
const decodeStoreListing = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      files: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
)

/** Untrusted config is decoded once; diagnostics name the file, never rejected contents. */
function decode(schema, value, location) {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new ReleaseInputFailure({ location })),
  )
}

/** Git reads committed objects even when a hook runs with a dirty working tree. */
const git = Effect.fn('release.git')(function* (root, args, encoding = 'utf8') {
  const result = NodeChildProcess.spawnSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: 1 << 28,
  })
  if (result.status !== 0)
    return yield* Effect.fail(new ReleaseInputFailure({ location: `git ${args.join(' ')}` }))
  return result.stdout
})

/** pnpm 12 prepends a separate tool lock document; the phone lives in the workspace document. */
const lockfile = Effect.fn('release.lockfile')(function* (root, revision) {
  const contents = yield* git(root, ['show', `${revision}:pnpm-lock.yaml`])
  const documents = YAML.parseAllDocuments(contents)
  for (const document of documents) {
    if (document.errors.length > 0)
      return yield* Effect.fail(
        new ReleaseInputFailure({ location: `${revision}:pnpm-lock.yaml syntax` }),
      )
  }
  const workspace = documents.find((document) => document.hasIn(['importers', 'apps/mobile']))
  if (workspace === undefined)
    return yield* Effect.fail(
      new ReleaseInputFailure({ location: `${revision}:pnpm-lock.yaml phone importer` }),
    )
  const value = yield* Effect.try({
    try: () => workspace.toJS(),
    catch: () =>
      new ReleaseInputFailure({ location: `${revision}:pnpm-lock.yaml workspace graph` }),
  })
  return yield* decode(Lockfile, value, `${revision}:pnpm-lock.yaml workspace graph`)
})

/** Both production edge kinds ship; an unresolved locked edge fails closed, including optional ones. */
function edges(record) {
  return Object.entries({ ...record.dependencies, ...record.optionalDependencies })
}

/** Strip peer and patch contexts for archive identity, retaining them while traversing snapshots. */
function archiveKey(key) {
  return key.split('(')[0]
}

/** A graph per revision sees removed dependencies and ignores unrelated server patches and upgrades. */
const phoneGraph = Effect.fn('release.phoneGraph')(function* (lock) {
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
      return yield* Effect.fail(
        new ReleaseInputFailure({ location: `lock snapshot ${current.key}` }),
      )
    if (current.kind === 'workspace') workspaces.add(current.key)
    else {
      const key = archiveKey(current.key)
      const metadata = lock.packages[key]
      if (metadata === undefined)
        return yield* Effect.fail(new ReleaseInputFailure({ location: `lock package ${key}` }))
      packages.set(key, metadata.resolution)
    }
    for (const [name, edge] of edges(record)) {
      const version = current.kind === 'workspace' ? edge.version : edge
      queue.push(yield* resolveEdge(lock, current, name, version))
    }
  }
  return { workspaces, packages }
})

/** Workspace links are relative to their importer; registry aliases name their own snapshot. */
const resolveEdge = Effect.fn('release.resolveEdge')(function* (lock, current, name, version) {
  if (version.startsWith('link:')) {
    return {
      kind: 'workspace',
      key: NodePath.posix.normalize(NodePath.posix.join(current.key, version.slice(5))),
    }
  }
  const named = `${name}@${version}`
  if (lock.snapshots[named] !== undefined) return { kind: 'package', key: named }
  if (lock.snapshots[version] !== undefined) return { kind: 'package', key: version }
  return yield* Effect.fail(
    new ReleaseInputFailure({ location: `unresolved phone dependency ${name}` }),
  )
})

/** Tar is read without extraction; version-pinned archives determine native capability, never node_modules. */
const nativeArchive = Effect.fn('release.nativeArchive')(function* (bytes, key) {
  const result = NodeChildProcess.spawnSync('tar', ['-tzf', '-'], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  if (result.status !== 0) return yield* Effect.fail(new ArchiveFailure({ dependency: key }))
  return result.stdout.split('\n').some(nativeEntry)
})

/** The same path predicate applies to tar listings and pnpm's unpacked archive index. */
function nativeEntry(file) {
  return (
    /(?:^|\/)(?:ios|android)\//u.test(file) ||
    /(?:^|\/)(?:app\.plugin\.[cm]?js|expo-module\.config\.json|[^/]+\.podspec)$/u.test(file)
  )
}

/** Integrity binds fetched bytes to this revision's lock. A registry response alone is not proof. */
const verifyArchive = Effect.fn('release.verifyArchive')(function* (bytes, resolution, key) {
  if (resolution.integrity === undefined)
    return yield* Effect.fail(new ArchiveFailure({ dependency: key }))
  const [algorithm, digest] = resolution.integrity.split('-')
  if (!['sha512', 'sha256', 'sha1'].includes(algorithm))
    return yield* Effect.fail(new ArchiveFailure({ dependency: key }))
  const actual = NodeCrypto.createHash(algorithm).update(bytes).digest('base64')
  if (actual !== digest) return yield* Effect.fail(new ArchiveFailure({ dependency: key }))
  return yield* nativeArchive(bytes, key)
})

/** pnpm 12.4.2 stores unpacked archives in v11/index.db; its public offline command decodes them.
 * Bind the listing to the lock's integrity by requiring exactly one row for this package identity,
 * before and after cat-index. Ambiguous identities require the original archive instead.
 * cat-index omits integrity in its JSON, so accepting its output without this binding is unsafe.
 */
const storedArchive = Effect.fn('release.storedArchive')(function* (root, resolution, key) {
  if (resolution.integrity === undefined) return undefined
  const store = NodeChildProcess.spawnSync('pnpm', ['store', 'path'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (store.status !== 0) return undefined
  const path = NodePath.join(store.stdout.trim(), 'index.db')
  if (!NodeFS.existsSync(path)) return undefined
  const sqlite = yield* Effect.tryPromise({
    try: () => import('node:sqlite'),
    catch: () => new ArchiveFailure({ dependency: key }),
  })
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => new sqlite.DatabaseSync(path, { readOnly: true }),
      catch: () => new ArchiveFailure({ dependency: key }),
    }),
    (database) => indexedArchive(database, root, key, resolution.integrity),
    (database) => Effect.sync(() => database.close()),
  )
})

/** Only a unique immutable archive identity can make pnpm's package selector unambiguous. */
const storeIdentity = Effect.fn('release.storeIdentity')(function* (database, key) {
  const rows = yield* Effect.try({
    try: () =>
      database
        .prepare('SELECT key FROM package_index WHERE substr(key, instr(key, char(9)) + 1) = ?')
        .all(key),
    catch: () => new ArchiveFailure({ dependency: key }),
  })
  return yield* decodeStoreIdentity(rows).pipe(
    Effect.mapError(() => new ArchiveFailure({ dependency: key })),
  )
})

/** No registry resolution or current node_modules may replace this revision's locked archive. */
const indexedArchive = Effect.fn('release.indexedArchive')(
  function* (database, root, key, integrity) {
    const identity = `${integrity}\t${key}`
    const before = yield* storeIdentity(database, key)
    if (before.length !== 1 || before[0].key !== identity) return undefined
    const index = NodeChildProcess.spawnSync('pnpm', ['cat-index', key, '--offline'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    })
    if (index.status !== 0) return undefined
    const after = yield* storeIdentity(database, key)
    if (after.length !== 1 || after[0].key !== identity) return undefined
    const listing = yield* decodeStoreListing(index.stdout).pipe(
      Effect.mapError(() => new ArchiveFailure({ dependency: key })),
    )
    return Object.keys(listing.files).some(nativeEntry)
  },
)

/** Local vendored archives come from Git; remote archives use the exact locked version and integrity. */
const inspectArchive = Effect.fn('release.inspectArchive')(
  function* (root, revision, key, resolution) {
    const tarball = resolution.tarball
    if (tarball !== undefined && tarball.startsWith('file:')) {
      return yield* verifyArchive(
        yield* git(root, ['show', `${revision}:${tarball.slice(5)}`], null),
        resolution,
        key,
      )
    }
    const cached = yield* storedArchive(root, resolution, key)
    if (cached !== undefined) return cached
    const separator = key.lastIndexOf('@')
    const name = key.slice(0, separator)
    const version = key.slice(separator + 1)
    const url =
      tarball === undefined
        ? `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
        : tarball
    const bytes = yield* Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: (signal) => fetch(url, { signal: AbortSignal.any([signal, controller.signal]) }),
            catch: () => new ArchiveAvailabilityFailure({ dependency: key }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: archiveIdle,
              orElse: () => Effect.fail(new ArchiveTransferIdle({ dependency: key })),
            }),
          )
          if (!response.ok) {
            const failure =
              response.status === 408 || response.status === 429 || response.status >= 500
                ? new ArchiveAvailabilityFailure({ dependency: key })
                : new ArchiveFailure({ dependency: key })
            return yield* Effect.fail(failure)
          }
          if (response.body === null)
            return yield* Effect.fail(new ArchiveFailure({ dependency: key }))
          const chunks = yield* Stream.fromReadableStream({
            evaluate: () => response.body,
            onError: () => new ArchiveAvailabilityFailure({ dependency: key }),
          }).pipe(
            Stream.timeoutOrElse({
              duration: archiveIdle,
              orElse: () => Stream.fail(new ArchiveTransferIdle({ dependency: key })),
            }),
            Stream.runCollect,
          )
          return Buffer.concat(chunks)
        }),
      (controller) => Effect.sync(() => controller.abort()),
    )
    return yield* verifyArchive(bytes, resolution, key)
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
    exports: _exports,
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
const olderRuntimes = Effect.fn('release.olderRuntimes')(function* (root, revision) {
  const publisher = yield* git(root, ['show', `${revision}:apps/mobile/scripts/publish.mjs`])
  const match = /^const ALSO_RUNS_ON = (\[[\s\S]*?\])/mu.exec(publisher)
  if (match === null)
    return yield* Effect.fail(
      new ReleaseInputFailure({ location: `${revision}:publish.mjs ALSO_RUNS_ON literal` }),
    )
  const runtimes = yield* Effect.try({
    try: () => YAML.parse(match[1]),
    catch: () =>
      new ReleaseInputFailure({ location: `${revision}:publish.mjs ALSO_RUNS_ON literal` }),
  })
  return yield* decode(
    Schema.Array(Schema.String),
    runtimes,
    `${revision}:publish.mjs ALSO_RUNS_ON`,
  )
})

/** Both old and new graphs matter when a native dependency or its patch disappears. */
const nativeChanges = Effect.fn('release.nativeChanges')(function* (root, snapshots, changed) {
  const [before, after] = snapshots
  const native = changed.filter(nativeFile)
  if (!NodeUtil.isDeepStrictEqual(nativeConfig(before.expo), nativeConfig(after.expo)))
    native.push('apps/mobile/app.json native config')
  if (!NodeUtil.isDeepStrictEqual(nativeManifest(before.manifest), nativeManifest(after.manifest)))
    native.push('apps/mobile/package.json native options')
  const dependencies = new Set(differentPackages(before.graph.packages, after.graph.packages))
  for (const key of yield* changedPatches(root, snapshots)) dependencies.add(key)
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
        Effect.retry({
          times: archiveAvailabilityRetries,
          while: Predicate.or(
            Predicate.isTagged('ArchiveAvailabilityFailure'),
            Predicate.isTagged('ArchiveTransferIdle'),
          ),
        }),
      )
    )
      return { key, native: true }
  }
  return { key, native: false }
})

/** Compare only patches applied to a phone dependency, including removal and changed patch bytes. */
const changedPatches = Effect.fn('release.changedPatches')(function* (root, snapshots) {
  const [before, after] = snapshots
  const changed = new Set()
  for (const snapshot of snapshots) {
    for (const [selector, path] of Object.entries(snapshot.patches)) {
      if (!snapshot.graph.packages.has(selector)) continue
      const other = snapshot === before ? after : before
      if (other.patches[selector] !== path || !other.graph.packages.has(selector))
        changed.add(selector)
      else if (
        (yield* git(root, ['show', `${snapshot.revision}:${path}`])) !==
        (yield* git(root, ['show', `${other.revision}:${path}`]))
      )
        changed.add(selector)
    }
  }
  return changed
})

/** A snapshot holds the config and dependency closure of one committed revision. */
const readSnapshot = Effect.fn('release.readSnapshot')(function* (root, revision) {
  const expo = (yield* decode(
    Schema.fromJsonString(Expo),
    yield* git(root, ['show', `${revision}:apps/mobile/app.json`]),
    `${revision}:apps/mobile/app.json`,
  )).expo
  const graph = yield* phoneGraph(yield* lockfile(root, revision))
  const contents = yield* git(root, ['show', `${revision}:pnpm-workspace.yaml`])
  const workspace = yield* Effect.try({
    try: () => YAML.parse(contents),
    catch: () => new ReleaseInputFailure({ location: `${revision}:pnpm-workspace.yaml syntax` }),
  })
  const patches = yield* decode(
    Schema.Struct({ patchedDependencies: Schema.optionalKey(Strings) }),
    workspace,
    `${revision}:pnpm-workspace.yaml patches`,
  )
  const selectors = patches.patchedDependencies === undefined ? {} : patches.patchedDependencies
  for (const selector of Object.keys(selectors)) {
    if (
      !/^(?:@[^/]+\/)?[^@]+@(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|file:.+)$/u.test(
        selector,
      )
    )
      return yield* Effect.fail(
        new ReleaseInputFailure({
          location: `${revision}:pnpm-workspace.yaml patchedDependencies selector ${selector}; use an exact name@version`,
        }),
      )
  }
  return {
    revision,
    expo,
    manifest: yield* decode(
      Schema.fromJsonString(Manifest),
      yield* git(root, ['show', `${revision}:apps/mobile/package.json`]),
      `${revision}:apps/mobile/package.json`,
    ),
    graph,
    patches: selectors,
  }
})

/** Branch changes start at the merge base; release numbers must exceed the published main. */
const checkRelease = Effect.fn('release.checkRelease')(function* (root, base, head) {
  const ancestor = (yield* git(root, ['merge-base', base, head])).trim()
  const before = yield* readSnapshot(root, ancestor)
  const after = yield* readSnapshot(root, head)
  const published = yield* decode(
    Schema.fromJsonString(Expo),
    yield* git(root, ['show', `${base}:apps/mobile/app.json`]),
    `${base}:apps/mobile/app.json`,
  )
  const errors = []
  if (!isString(after.expo.runtimeVersion)) {
    return [
      'apps/mobile/app.json runtimeVersion must be a literal string; appVersion policy strands installed phones when version rises.',
    ]
  }
  const diff = yield* git(root, ['diff', '--no-renames', '--name-only', '-z', ancestor, head])
  const changed = diff.split('\0').filter(Boolean)
  const workspaces = new Set([...before.graph.workspaces, ...after.graph.workspaces])
  const shipped = changed.filter((file) => shippedFile(file, workspaces))
  const dependencies = [
    ...differentPackages(before.graph.packages, after.graph.packages),
    ...(yield* changedPatches(root, [before, after])),
  ]
  const native = yield* nativeChanges(root, [before, after], changed)
  if (
    (shipped.length > 0 || dependencies.length > 0) &&
    !rises(published.expo.version, after.expo.version)
  ) {
    errors.push(
      'Phone inputs changed; raise version in apps/mobile/app.json above the published version.',
    )
  }
  if (native.length > 0) {
    if (!rises(published.expo.runtimeVersion, after.expo.runtimeVersion))
      errors.push(
        `Native inputs changed (${native.slice(0, 3).join(', ')}); raise runtimeVersion in apps/mobile/app.json.`,
      )
    if ((yield* olderRuntimes(root, head)).length > 0)
      errors.push('Native inputs changed; empty ALSO_RUNS_ON in apps/mobile/scripts/publish.mjs.')
  } else if (
    (shipped.length > 0 || dependencies.length > 0) &&
    after.expo.runtimeVersion !== published.expo.runtimeVersion
  ) {
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
    const failure = result.failure
    if (Predicate.isTagged(failure, 'ReleaseInputFailure'))
      process.stderr.write(`phone release check could not read ${failure.location}.\n`)
    else
      process.stderr.write(
        `phone release check could not inspect ${failure.dependency}; its locked archive must be available and match its integrity.\n`,
      )
    process.exitCode = 1
  } else {
    for (const error of result.success) process.stderr.write(`${error}\n`)
    process.exitCode = result.success.length === 0 ? 0 : 1
    if (result.success.length === 0)
      process.stdout.write(`phone release passed (${base}..${head})\n`)
  }
}

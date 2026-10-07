import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

const directory = NodeURL.fileURLToPath(new URL('../', import.meta.url))
// The native preview exports its manifest, not its executable subpath. Use the installed bin
// location verified in that manifest rather than resolving an unexported package subpath.
const nativeCompiler = NodeURL.fileURLToPath(
  new URL('bin/tsc', import.meta.resolve('@typescript/native/package.json')),
)
// Classic TypeScript is already installed in the repository; this proof adds no dependency.
const classicCompiler = NodeURL.fileURLToPath(
  new URL('bin/tsc', import.meta.resolve('typescript/package.json')),
)
const compilers = [
  { name: 'native', file: nativeCompiler },
  { name: 'classic', file: classicCompiler },
]

// Read only the manifest fields that define this proof. Decode each file once at ingress;
// the packed manifest must carry published exports instead of the workspace source entries.
const Peers = Schema.Record(Schema.String, Schema.String)
const Exports = Schema.Record(
  Schema.String,
  Schema.Struct({ types: Schema.String, default: Schema.String }),
)
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      peerDependencies: Peers,
      publishConfig: Schema.Struct({ exports: Exports }),
    }),
  ),
)
const decodeWorkspace = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ packageManager: Schema.String })),
)
const decodeNodeTypes = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)
const decodeInstalled = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ exports: Exports, peerDependencies: Peers })),
)

/** Keep subprocess failures visible and never continue with a partial build, pack, or install. */
function run(program, args, cwd) {
  const result = NodeChildProcess.spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error !== undefined) throw result.error
  process.stdout.write(result.stdout)
  NodeAssert.equal(result.status, 0, `${program} ${args.join(' ')} failed (${result.signal})`)
  return result.stdout
}

/** Pack from clean compiler output and reject source, tests, fixtures, and build tooling. */
async function pack(temporary) {
  run('pnpm', ['pack', '--pack-destination', temporary], directory)
  const archives = (await NodeFSP.readdir(temporary)).filter((name) => name.endsWith('.tgz'))
  NodeAssert.equal(archives.length, 1, 'Expected exactly one package tarball')
  const archive = NodePath.join(temporary, archives[0])
  const files = run('tar', ['-tzf', archive], directory).trim().split('\n')
  NodeAssert.ok(
    files.every((file) =>
      /^(?:package\/dist\/(?:postgres\/)?[^/]+\.(?:js|d\.ts)|package\/(?:README\.md|package\.json))$/u.test(
        file,
      ),
    ),
    'Tarball contains a file outside the published surface',
  )
  for (const entry of ['main', 'core', 'client', 'postgres/main']) {
    for (const suffix of ['js', 'd.ts']) {
      NodeAssert.ok(files.includes(`package/dist/${entry}.${suffix}`))
    }
  }
  return archive
}

/** An explicit workspace root prevents this nested cache project from joining the host workspace. */
async function project(temporary, archive) {
  const consumer = NodePath.join(temporary, 'consumer')
  await NodeFSP.mkdir(consumer)
  const manifest = decodeManifest(
    await NodeFSP.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const workspace = decodeWorkspace(
    await NodeFSP.readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
  )
  const nodeTypes = decodeNodeTypes(
    await NodeFSP.readFile(
      NodeURL.fileURLToPath(import.meta.resolve('@types/node/package.json')),
      'utf8',
    ),
  )
  const consumerManifest = {
    name: 'durable-consumer-proof',
    private: true,
    type: 'module',
    packageManager: workspace.packageManager,
    dependencies: { [manifest.name]: `file:${archive}`, ...manifest.peerDependencies },
    devDependencies: { '@types/node': nodeTypes.version },
  }
  await NodeFSP.writeFile(
    NodePath.join(consumer, 'package.json'),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
  )
  // Peers are installed explicitly. Pin their transitive uses too so Pi's caret dependencies
  // cannot pull another copy/version of the host's shared instances into the proof.
  const overrides = Object.entries(manifest.peerDependencies)
    .map(([name, version]) => `  '${name}': '${version}'`)
    .join('\n')
  await NodeFSP.writeFile(
    NodePath.join(consumer, 'pnpm-workspace.yaml'),
    `packages:\n  - '.'\noverrides:\n${overrides}\n`,
  )
  for (const file of ['stream.mjs', 'types.ts']) {
    await NodeFSP.copyFile(new URL(file, import.meta.url), NodePath.join(consumer, file))
  }
  run('pnpm', ['install', '--ignore-scripts', '--strict-peer-dependencies'], consumer)
  const installed = decodeInstalled(
    await NodeFSP.readFile(
      NodePath.join(consumer, 'node_modules', manifest.name, 'package.json'),
      'utf8',
    ),
  )
  // Inspect the declaration consumers actually receive, not the source facade: tuple forwarding
  // hides parameter names and couples the Promise contract to an Effect implementation signature.
  const facade = await NodeFSP.readFile(
    NodePath.join(consumer, 'node_modules', manifest.name, 'dist', 'main.d.ts'),
    'utf8',
  )
  NodeAssert.doesNotMatch(facade, /\.\.\.args|Parameters<typeof Core\./u)
  NodeAssert.deepEqual(installed.exports, manifest.publishConfig.exports)
  NodeAssert.deepEqual(installed.peerDependencies, manifest.peerDependencies)
  return consumer
}

/**
 * Check consumer declarations without workspace paths or source conditions. TypeScript 6.0.3's
 * declaration transformer preserves relative specifiers (rewriteModuleSpecifier2); its resolver
 * must find the shipped .d.ts siblings even though rewriteRelativeImportExtensions rewrites JS only.
 */
async function types(consumer, resolution, compiler) {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2023', 'DOM'],
      module: resolution === 'bundler' ? 'ESNext' : 'NodeNext',
      moduleResolution: resolution,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    },
    files: ['types.ts'],
  }
  const file = NodePath.join(consumer, `tsconfig.${compiler.name}.${resolution}.json`)
  await NodeFSP.writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
  run(process.execPath, [compiler.file, '-p', file], consumer)
  process.stdout.write(`Type resolution (${compiler.name}, ${resolution}): passed\n`)
}

// Build before creating the proof directory: a compiler failure cannot leave a misleading tarball.
run('pnpm', ['build'], directory)
const cache = NodePath.join(directory, 'node_modules', '.cache')
await NodeFSP.mkdir(cache, { recursive: true })
const temporary = await NodeFSP.mkdtemp(NodePath.join(cache, 'durable-consumer-'))
process.stdout.write(`Packaging proof directory: ${temporary}\n`)
const consumer = await project(temporary, await pack(temporary))
for (const compiler of compilers) {
  run(process.execPath, [compiler.file, '--version'], consumer)
  await types(consumer, 'bundler', compiler)
  await types(consumer, 'nodenext', compiler)
}
run(process.execPath, ['stream.mjs'], consumer)
await NodeFSP.rm(temporary, { recursive: true, force: true })
process.stdout.write('Package consumer proof: passed (temporary directory removed)\n')

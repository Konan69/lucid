import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Schema from 'effect/Schema'
import * as Result from 'effect/Result'
import * as TypeScript from 'typescript'

const Manifest = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
const decodeManifest = Schema.decodeUnknownResult(Schema.fromJsonString(Manifest))
const hermesLib = ['lib.es2022.d.ts']
const domLib = [...hermesLib, 'lib.dom.d.ts']
const browserLib = [...domLib, 'lib.dom.iterable.d.ts']

/** Only TypeScript's bundled libraries count here; dependency declaration names are unrelated. */
function libraryFiles(program) {
  return program
    .getSourceFiles()
    .filter((source) => /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(source.fileName))
}

/** Imports and triple-slash references can widen a program even when compilerOptions.lib is narrow. */
function productionProgram(config) {
  return TypeScript.createProgram({ rootNames: config.fileNames, options: config.options })
}

/** Inspect the import graph too, so a cross-app import cannot escape the phone's lint coverage. */
export function productionSources(root, directory) {
  const { config, diagnostics } = productionConfig(root, directory)
  if (config === undefined || diagnostics.length > 0)
    throw new Error(`Cannot read ${directory} production project`)
  return productionProgram(config)
    .getSourceFiles()
    .filter((source) => !source.isDeclarationFile && !source.fileName.includes('/node_modules/'))
    .map((source) => NodePath.relative(root, source.fileName))
}

/** Build the permitted transitive lib set from TypeScript itself, without application or @types imports. */
function allowedLibraries(lib) {
  const directory = NodePath.dirname(TypeScript.getDefaultLibFilePath({}))
  const program = TypeScript.createProgram({
    rootNames: lib.map((file) => NodePath.join(directory, file)),
    options: { lib, types: [] },
  })
  return new Set(libraryFiles(program).map((source) => NodePath.basename(source.fileName)))
}

/** Keep the cheap config diagnostic separate from the loaded-library check so both causes are visible. */
function libraryErrors(config, relative) {
  const errors = []
  const key = JSON.stringify(config.options.lib)
  const lib = [hermesLib, domLib, browserLib].find((candidate) => JSON.stringify(candidate) === key)
  if (lib === undefined) {
    return [
      `${relative}: effective lib must be ES2022, with DOM and DOM.Iterable only where needed for Hermes; use effect/Array instead of raising lib`,
    ]
  }
  const allowed = allowedLibraries(lib)
  const loaded = libraryFiles(productionProgram(config)).map((source) =>
    NodePath.basename(source.fileName),
  )
  const wider = loaded.filter((file) => !allowed.has(file))
  if (wider.length > 0)
    errors.push(`${relative}: loaded libraries exceed the Hermes profile: ${wider.join(', ')}`)
  return errors
}

/** Follow runtime workspace edges, including optional and peer imports, rather than a fixed list. */
export function mobileClosure(root, manifestPaths) {
  // Invalid manifests cannot define a usable workspace; the policy command must stop on them.
  const manifests = manifestPaths.map((path) => ({
    directory: NodePath.dirname(path),
    manifest: Result.getOrThrow(
      decodeManifest(NodeFS.readFileSync(NodePath.join(root, path), 'utf8')),
    ),
  }))
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]))
  const pending = ['@vivid/mobile']
  const visited = new Set()
  const closure = []
  for (const name of pending) {
    if (visited.has(name)) continue
    visited.add(name)
    const entry = byName.get(name)
    if (entry === undefined) throw new Error(`Missing workspace package ${name}`)
    closure.push(entry.directory)
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = entry.manifest[section]
      if (dependencies === undefined) continue
      pending.push(...Object.keys(dependencies).filter((dependency) => byName.has(dependency)))
    }
  }
  return closure
}

/** Use TypeScript's own JSONC and inheritance resolution, so Expo cannot silently supply ESNext. */
function productionConfig(root, directory) {
  const types = NodePath.join(root, directory, 'tsconfig.types.json')
  const path = NodeFS.existsSync(types) ? types : NodePath.join(root, directory, 'tsconfig.json')
  const diagnostics = []
  const config = TypeScript.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...TypeScript.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  )
  if (config === undefined) return { path, diagnostics }
  return { path, config, diagnostics: diagnostics.concat(config.errors) }
}

/**
 * TS2550 recommends raising lib. Refuse that remedy on every package shipped to Hermes,
 * including shared packages checked separately by Turbo before the phone consumes their types.
 */
export function hermesConfigErrors(root, manifestPaths) {
  return mobileClosure(root, manifestPaths).flatMap((directory) => {
    const { path, config, diagnostics } = productionConfig(root, directory)
    const relative = NodePath.relative(root, path)
    if (config === undefined || diagnostics.length > 0) {
      return [`${relative}: cannot read Hermes production project`].concat(
        diagnostics.map((diagnostic) =>
          TypeScript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        ),
      )
    }
    const errors = libraryErrors(config, relative)
    if (!config.fileNames.includes(NodePath.join(root, 'hermes.d.ts'))) {
      errors.push(`${relative}: inherit tsconfig.hermes.json to include hermes.d.ts`)
    }
    if (config.fileNames.some((file) => /(?:\.test\.tsx?$|\/tests\/)/u.test(file))) {
      errors.push(
        `${relative}: production includes tests; move them to tsconfig.tests.json with Node's lib`,
      )
    }
    return errors
  })
}

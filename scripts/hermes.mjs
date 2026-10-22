import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Schema from 'effect/Schema'
import * as Result from 'effect/Result'
import { API } from 'tsc-rs/unstable/sync'
import { libraryDirectory } from './native.mjs'

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

function libraryFiles(program) {
  return program
    .getSourceFileNames()
    .filter(
      (file) =>
        file.startsWith(`${libraryDirectory}/`) &&
        /^lib\.[^/]+\.d\.ts$/u.test(NodePath.basename(file)),
    )
}

function productionProgram(api, config) {
  return api.createProgram(config.fileNames, config.options)
}

export function productionSources(root, directory) {
  using api = new API({ cwd: root })
  const { config, diagnostics } = productionConfig(api, root, directory)
  if (config === undefined || diagnostics.length > 0)
    throw new Error(`Cannot read ${directory} production project`)
  using program = productionProgram(api, config)
  return program
    .getSourceFileNames()
    .filter((file) => !/\.d\.[cm]?ts$/u.test(file) && !file.includes('/node_modules/'))
    .map((file) => NodePath.relative(root, file))
}

function allowedLibraries(api, lib) {
  using program = api.createProgram(
    lib.map((file) => NodePath.join(libraryDirectory, file)),
    { lib, types: [] },
  )
  return new Set(libraryFiles(program).map((file) => NodePath.basename(file)))
}

/** Keep the cheap config diagnostic separate from the loaded-library check so both causes are visible. */
function libraryErrors(api, config, relative) {
  const errors = []
  const key = JSON.stringify(config.options.lib)
  const lib = [hermesLib, domLib, browserLib].find((candidate) => JSON.stringify(candidate) === key)
  if (lib === undefined) {
    return [
      `${relative}: effective lib must be ES2022, with DOM and DOM.Iterable only where needed for Hermes; use effect/Array instead of raising lib`,
    ]
  }
  const allowed = allowedLibraries(api, lib)
  using program = productionProgram(api, config)
  const loaded = libraryFiles(program).map((file) => NodePath.basename(file))
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

function productionConfig(api, root, directory) {
  const types = NodePath.join(root, directory, 'tsconfig.types.json')
  const path = NodeFS.existsSync(types) ? types : NodePath.join(root, directory, 'tsconfig.json')
  const config = api.parseConfigFile(path)
  return { path, config, diagnostics: config.errors }
}

/**
 * TS2550 recommends raising lib. Refuse that remedy on every package shipped to Hermes,
 * including shared packages checked separately by Turbo before the phone consumes their types.
 */
export function hermesConfigErrors(root, manifestPaths) {
  using api = new API({ cwd: root })
  return mobileClosure(root, manifestPaths).flatMap((directory) => {
    const { path, config, diagnostics } = productionConfig(api, root, directory)
    const relative = NodePath.relative(root, path)
    if (config === undefined || diagnostics.length > 0) {
      return [`${relative}: cannot read Hermes production project`].concat(
        diagnostics.map((diagnostic) => diagnostic.text),
      )
    }
    const errors = libraryErrors(api, config, relative)
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

#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import { parseJsonc } from './jsonc.mjs'
import { hermesConfigErrors } from './hermes.mjs'

export const versions = Object.freeze({
  '@earendil-works/chord': '1.4.0',
  '@earendil-works/pi-ai': '1.4.0',
  '@earendil-works/pi-durable': '1.4.0',
  '@valibot/to-json-schema': '1.7.1',
  '@effect/ai-openrouter': '4.0.2',
  '@effect/ai-typesafe': '4.0.2',
  '@maschwenk/tsrslint': '0.1.5',
  'tsc-rs': '0.8.0',
  'oxc-parser': '0.154.0',
  'jsonc-parser': '3.3.1',
  '@effect/platform-node': '4.0.2',
  '@effect/sql-pg': '4.0.2',
  '@effect/vitest': '4.0.2',
  '@react-native/metro-config': '0.86.3',
  '@react-navigation/native': '7.4.1',
  '@react-navigation/native-stack': '7.19.2',
  '@shadcn/lint': '0.1.1',
  '@tailwindcss/vite': '4.3.3',
  '@types/node': '24.13.6',
  '@types/pg': '8.23.1',
  '@types/react': '19.2.18',
  '@types/react-dom': '19.2.3',
  '@vitejs/plugin-react': '6.1.1',
  alchemy: '2.0.0-beta.81',
  'better-auth': '1.7.5',
  'drizzle-kit': '1.0.0-rc.5-ab785fc',
  'drizzle-orm': '1.0.0-rc.5-ab785fc',
  effect: '4.0.2',
  electron: '44.4.3',
  'electron-builder': '26.15.3',
  'electron-builder-squirrel-windows': '26.15.3',
  esbuild: '0.28.2',
  expo: '57.0.31',
  'expo-crypto': '57.0.4',
  'expo-dev-client': '57.0.20',
  'expo-document-picker': '57.0.3',
  'expo-file-system': '57.0.7',
  'expo-haptics': '57.0.3',
  'expo-secure-store': '57.0.4',
  'expo-sharing': '57.0.24',
  'expo-system-ui': '57.0.4',
  hono: '4.13.8',
  'lucide-react': '1.47.0',
  'lucide-react-native': '1.47.0',
  oxlint: '1.83.0',
  'oxlint-tailwindcss': '1.12.0',
  pg: '8.23.0',
  react: '19.2.3',
  'react-dom': '19.2.3',
  'react-native': '0.86.3',
  'react-native-gesture-handler': '2.32.0',
  'react-native-reanimated': '4.5.1',
  'react-native-web': '0.21.2',
  'react-native-worklets': '0.10.1',
  tailwindcss: '4.3.3',
  tsx: '4.23.13',
  valibot: '1.5.0',
  vite: '8.3.0',
  vitest: '5.0.1',
})

const forcedVersions = Object.freeze({
  '@effect/platform-node': versions['@effect/platform-node'],
  '@effect/sql-pg': versions['@effect/sql-pg'],
  'drizzle-kit': versions['drizzle-kit'],
  'drizzle-orm': versions['drizzle-orm'],
  effect: versions.effect,
})

const requiredByManifest = Object.freeze({
  'package.json': [
    '@effect/vitest',
    '@maschwenk/tsrslint',
    '@shadcn/lint',
    '@types/node',
    'oxlint',
    'oxlint-tailwindcss',
    'vitest',
  ],
  'apps/desktop/package.json': [
    '@effect/vitest',
    '@types/node',
    'effect',
    'electron',
    'electron-builder',
    'electron-builder-squirrel-windows',
    'esbuild',
    'vitest',
  ],
  'apps/mobile/package.json': [
    '@react-native/metro-config',
    '@react-navigation/native',
    '@react-navigation/native-stack',
    '@types/react',
    'expo',
    'expo-crypto',
    'expo-dev-client',
    'expo-document-picker',
    'expo-file-system',
    'expo-haptics',
    'expo-secure-store',
    'expo-sharing',
    'expo-system-ui',
    'lucide-react-native',
    'react',
    'react-dom',
    'react-native',
    'react-native-gesture-handler',
    'react-native-reanimated',
    'react-native-web',
    'react-native-worklets',
  ],
  'apps/server/package.json': [
    '@effect/platform-node',
    '@effect/sql-pg',
    '@types/node',
    '@types/pg',
    'alchemy',
    'better-auth',
    'drizzle-kit',
    'drizzle-orm',
    'effect',
    'pg',
    'tsx',
  ],
  'apps/web/package.json': [
    '@tailwindcss/vite',
    '@types/react',
    '@types/react-dom',
    '@vitejs/plugin-react',
    'lucide-react',
    'react',
    'react-dom',
    'tailwindcss',
    'vite',
  ],
  'apps/cells/package.json': ['@earendil-works/chord', '@earendil-works/pi-durable', 'effect'],
  'packages/agent/runtime/package.json': [
    '@earendil-works/chord',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-durable',
    '@valibot/to-json-schema',
    '@effect/platform-node',
    '@types/node',
    'drizzle-orm',
    'effect',
    'drizzle-kit',
    'valibot',
  ],
  'packages/contracts/package.json': ['effect'],
})

const DependencyMap = Schema.Record(Schema.String, Schema.String)
const PackageManifest = Schema.Struct({
  dependencies: Schema.optionalKey(DependencyMap),
  devDependencies: Schema.optionalKey(DependencyMap),
  optionalDependencies: Schema.optionalKey(DependencyMap),
  peerDependencies: Schema.optionalKey(DependencyMap),
  pnpm: Schema.optionalKey(Schema.Unknown),
  scripts: Schema.optionalKey(DependencyMap),
})
const TypeScriptConfig = Schema.Struct({
  compilerOptions: Schema.optionalKey(
    Schema.Struct({
      plugins: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            diagnostics: Schema.optionalKey(Schema.Boolean),
            ignoreEffectErrorsInTscExitCode: Schema.optionalKey(Schema.Boolean),
            ignoreEffectWarningsInTscExitCode: Schema.optionalKey(Schema.Boolean),
            ignoreEffectSuggestionsInTscExitCode: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      ),
    }),
  ),
})
const decodePackageManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest))
const decodeTypeScriptConfig = Schema.decodeUnknownSync(TypeScriptConfig)
const readPackageManifest = (root, relativePath) =>
  decodePackageManifest(NodeFS.readFileSync(NodePath.join(root, relativePath), 'utf8'))
const readTypeScriptConfig = (root, relativePath) => {
  const source = NodeFS.readFileSync(NodePath.join(root, relativePath), 'utf8')
  return decodeTypeScriptConfig(parseJsonc(source, relativePath))
}

/** Read one flat mapping from pnpm-workspace.yaml without adding a bootstrap dependency. */
function readWorkspaceMapping(root, section) {
  const lines = NodeFS.readFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n')
  const values = {}
  let active = false

  for (const line of lines) {
    if (!line.startsWith(' ')) {
      active = line === `${section}:`
      continue
    }
    if (
      !active ||
      !line.startsWith('  ') ||
      line.startsWith('    ') ||
      line.trimStart().startsWith('#')
    ) {
      continue
    }

    const separator = line.indexOf(':', 2)
    if (separator === -1) continue
    const rawName = line.slice(2, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    const unquote = (value) => value.replace(/^(['"])(.*)\1$/u, '$2')
    values[unquote(rawName)] = unquote(rawValue)
  }

  return values
}

/** Resolve a manifest or override catalog reference to its authoritative workspace pin. */
function resolveWorkspaceVersion(name, value, catalog) {
  return value === 'catalog:' ? catalog[name] : value
}

/** True when `relativePath` names a readable file under `root`. */
const isReadable = (root, relativePath) => {
  try {
    NodeFS.readFileSync(NodePath.join(root, relativePath))
    return true
  } catch {
    return false
  }
}

/** Names of the directories directly under `root/relative`. */
const directoriesIn = (root, relative) =>
  NodeFS.readdirSync(NodePath.join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${relative}/${entry.name}`)

/**
 * Return every workspace package manifest. A package sits directly under `apps/` or `packages/`,
 * or one level deeper inside a group directory such as `packages/design/tokens`; a directory with
 * its own manifest is a package, so its children are not searched.
 */
export function workspaceManifestPaths(root) {
  return ['apps', 'packages'].flatMap((parent) =>
    directoriesIn(root, parent).flatMap((directory) =>
      isReadable(root, `${directory}/package.json`)
        ? [`${directory}/package.json`]
        : directoriesIn(root, directory)
            .map((child) => `${child}/package.json`)
            .filter((manifest) => isReadable(root, manifest)),
    ),
  )
}

const manifestSections = (manifest) => [
  { section: 'dependencies', dependencies: manifest.dependencies },
  { section: 'devDependencies', dependencies: manifest.devDependencies },
  { section: 'peerDependencies', dependencies: manifest.peerDependencies },
  { section: 'optionalDependencies', dependencies: manifest.optionalDependencies },
]

/** Report version drift in one dependency section. */
function dependencySectionErrors(relativePath, section, dependencies, catalog) {
  if (dependencies === undefined) return []
  const errors = []
  for (const [name, expected] of Object.entries(versions)) {
    const declared = dependencies[name]
    const actual = resolveWorkspaceVersion(name, declared, catalog)
    if (declared !== undefined && actual !== expected) {
      errors.push(
        `${relativePath}: ${section}.${name} must resolve to ${expected}; found ${declared}`,
      )
    }
  }
  return errors
}

/** Validate one workspace manifest against every authoritative version pin. */
function manifestErrors(relativePath, manifest, catalog) {
  return manifestSections(manifest).flatMap(({ section, dependencies }) =>
    dependencySectionErrors(relativePath, section, dependencies, catalog),
  )
}

/** Report missing or drifting dependencies required on specific package surfaces. */
function requiredDependencyErrors(root, catalog) {
  return Object.entries(requiredByManifest).flatMap(([relativePath, names]) => {
    const manifest = readPackageManifest(root, relativePath)
    const production = manifest.dependencies === undefined ? {} : manifest.dependencies
    const development = manifest.devDependencies === undefined ? {} : manifest.devDependencies
    return names.flatMap((name) => {
      const declared = production[name] ?? development[name]
      const actual = resolveWorkspaceVersion(name, declared, catalog)
      return actual === versions[name]
        ? []
        : [`${relativePath}: ${name} must resolve to ${versions[name]}; found ${declared}`]
    })
  })
}

/** Report drift in pnpm overrides that force prerelease packages into lockstep. */
function overrideErrors(overrides, catalog) {
  return Object.entries(forcedVersions).flatMap(([name, expected]) => {
    const declared = overrides[name]
    const actual = resolveWorkspaceVersion(name, declared, catalog)
    return actual === expected
      ? []
      : [`pnpm-workspace.yaml: overrides.${name} must resolve to ${expected}; found ${declared}`]
  })
}

/** Report root package policies that keep every compiler path consistent. */
function rootManifestErrors(manifest) {
  const errors = []
  const development = manifest.devDependencies === undefined ? {} : manifest.devDependencies
  const scripts = manifest.scripts === undefined ? {} : manifest.scripts
  if (manifest.pnpm !== undefined)
    errors.push('package.json: pnpm settings belong in pnpm-workspace.yaml under pnpm 12')
  if (development['tsc-rs'] !== versions['tsc-rs'])
    errors.push(`package.json: tsc-rs must be ${versions['tsc-rs']}`)
  // The lint runner owns mandatory type-aware analysis; the public command must
  // enter Turbo so successful package checks and their diagnostics can be reused.
  if (scripts.lint === undefined || !scripts.lint.startsWith('turbo run lint lint:root ')) {
    errors.push('package.json: lint must run cached workspace and root lint through Turbo')
  }
  return errors
}

/** Report Effect language-service plugin drift in the shared TypeScript config. */
export function typeScriptConfigErrors(root) {
  const config = readTypeScriptConfig(root, 'tsconfig.base.json')
  const compilerOptions = config.compilerOptions === undefined ? {} : config.compilerOptions
  const plugins = compilerOptions.plugins === undefined ? [] : compilerOptions.plugins
  const effectPlugin = plugins.find((plugin) => plugin.name === '@effect/language-service')
  if (effectPlugin === undefined) {
    return ['tsconfig.base.json: @effect/language-service plugin is required']
  }
  const errors = []
  if (effectPlugin.diagnostics !== true) {
    errors.push('tsconfig.base.json: Effect diagnostics must be enabled')
  }
  // An Effect error, warning or suggestion fails typecheck. The options must be stated `false`:
  // left out, the compiler prints the finding and exits 0, which is how 1,677 of them gathered
  // unseen before 7 Oct 2026.
  for (const option of [
    'ignoreEffectErrorsInTscExitCode',
    'ignoreEffectWarningsInTscExitCode',
    'ignoreEffectSuggestionsInTscExitCode',
  ]) {
    if (effectPlugin[option] !== false) {
      errors.push(`tsconfig.base.json: ${option} must be false`)
    }
  }
  return errors
}

/** Validate dependency lockstep and the native TypeScript/Effect compiler path. */
export function validateVersions(root) {
  const rootManifest = readPackageManifest(root, 'package.json')
  const catalog = readWorkspaceMapping(root, 'catalog')
  const overrides = readWorkspaceMapping(root, 'overrides')
  const paths = ['package.json', ...workspaceManifestPaths(root)]
  return [
    ...paths.flatMap((relativePath) =>
      manifestErrors(relativePath, readPackageManifest(root, relativePath), catalog),
    ),
    ...requiredDependencyErrors(root, catalog),
    ...overrideErrors(overrides, catalog),
    ...rootManifestErrors(rootManifest),
    ...typeScriptConfigErrors(root),
    ...hermesConfigErrors(root, paths.slice(1)),
  ]
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
  const errors = validateVersions(root)
  if (errors.length > 0) {
    process.stderr.write(
      `version lockstep failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`,
    )
    process.exitCode = 1
  } else {
    process.stdout.write('version lockstep passed\n')
  }
}

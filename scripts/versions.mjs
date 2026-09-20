#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

export const versions = Object.freeze({
  '@alchemy.run/better-auth': '2.0.0-beta.79',
  '@earendil-works/pi-ai': '0.83.0',
  '@effect/language-service': '0.87.2',
  '@effect/platform-node': '4.0.0-rc.116',
  '@effect/sql-pg': '4.0.0-rc.116',
  '@effect/vitest': '4.0.0-rc.116',
  '@flue/cli': '2.1.0',
  '@flue/postgres': '2.1.0',
  '@flue/react': '2.1.0',
  '@flue/runtime': '2.1.0',
  '@flue/sdk': '2.1.0',
  '@flue/vite': '2.1.0',
  '@react-native/metro-config': '0.86.3',
  '@react-navigation/native': '7.4.1',
  '@react-navigation/native-stack': '7.19.2',
  '@shadcn/lint': '0.1.1',
  '@tailwindcss/vite': '4.3.3',
  '@types/node': '24.13.6',
  '@types/pg': '8.23.1',
  '@types/react': '19.2.18',
  '@types/react-dom': '19.2.3',
  '@typescript/native': 'npm:typescript@7.0.2',
  '@vitejs/plugin-react': '6.1.1',
  alchemy: '2.0.0-beta.79',
  'better-auth': '1.7.5',
  'drizzle-kit': '1.0.0-rc.5-ab785fc',
  'drizzle-orm': '1.0.0-rc.5-ab785fc',
  effect: '4.0.0-rc.116',
  expo: '57.0.24',
  'expo-crypto': '57.0.3',
  'expo-dev-client': '57.0.19',
  'expo-document-picker': '57.0.2',
  'expo-file-system': '57.0.7',
  'expo-haptics': '57.0.3',
  'expo-secure-store': '57.0.4',
  'expo-sharing': '57.0.21',
  'expo-system-ui': '57.0.4',
  hono: '4.12.32',
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
  typescript: '6.0.3',
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
    '@shadcn/lint',
    '@types/node',
    'oxlint',
    'oxlint-tailwindcss',
    'vitest',
  ],
  'apps/mobile/package.json': [
    '@effect/vitest',
    '@flue/react',
    '@flue/sdk',
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
    '@alchemy.run/better-auth',
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
    '@effect/vitest',
    '@flue/react',
    '@flue/sdk',
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
  'packages/agent-runtime/package.json': [
    '@earendil-works/pi-ai',
    '@effect/platform-node',
    '@flue/cli',
    '@flue/postgres',
    '@flue/runtime',
    '@flue/vite',
    '@types/node',
    '@types/pg',
    'drizzle-orm',
    'effect',
    'hono',
    'pg',
    'valibot',
    'vite',
  ],
  'packages/computer/package.json': ['@effect/platform-node', '@types/node', 'effect'],
  'packages/connectors/package.json': [
    '@types/node',
    '@types/pg',
    'drizzle-kit',
    'drizzle-orm',
    'effect',
    'pg',
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
          }),
        ),
      ),
    }),
  ),
})
const decodePackageManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest))
const decodeTypeScriptConfig = Schema.decodeUnknownSync(Schema.fromJsonString(TypeScriptConfig))
const readPackageManifest = (root, relativePath) =>
  decodePackageManifest(NodeFS.readFileSync(NodePath.join(root, relativePath), 'utf8'))
const readTypeScriptConfig = (root, relativePath) =>
  decodeTypeScriptConfig(NodeFS.readFileSync(NodePath.join(root, relativePath), 'utf8'))

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

/** Return every workspace package manifest that is present in this collaboration checkout. */
export function workspaceManifestPaths(root) {
  return ['apps', 'packages'].flatMap((parent) =>
    NodeFS.readdirSync(NodePath.join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}/package.json`)
      .filter((relativePath) => {
        try {
          NodeFS.readFileSync(NodePath.join(root, relativePath))
          return true
        } catch {
          return false
        }
      }),
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

/** Report native and tooling compiler drift for one package that runs tsc. */
function compilerErrors(relativePath, manifest, catalog) {
  const typecheck = manifest.scripts === undefined ? undefined : manifest.scripts.typecheck
  if (typecheck === undefined || !/(?:^|\s)tsc(?:\s|$)/u.test(typecheck)) return []
  const development = manifest.devDependencies === undefined ? {} : manifest.devDependencies
  const nativeTypeScript = resolveWorkspaceVersion(
    '@typescript/native',
    development['@typescript/native'],
    catalog,
  )
  const toolingTypeScript = resolveWorkspaceVersion('typescript', development.typescript, catalog)
  const errors = []
  if (nativeTypeScript !== versions['@typescript/native']) {
    errors.push(
      `${relativePath}: tsc typecheck must resolve @typescript/native ${versions['@typescript/native']}`,
    )
  }
  if (toolingTypeScript !== versions.typescript) {
    errors.push(`${relativePath}: tooling TypeScript must resolve to ${versions.typescript}`)
  }
  return errors
}

/** Validate one workspace manifest against every authoritative version pin. */
function manifestErrors(relativePath, manifest, catalog) {
  return [
    ...manifestSections(manifest).flatMap(({ section, dependencies }) =>
      dependencySectionErrors(relativePath, section, dependencies, catalog),
    ),
    ...compilerErrors(relativePath, manifest, catalog),
  ]
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
function rootManifestErrors(manifest, catalog) {
  const errors = []
  const development = manifest.devDependencies === undefined ? {} : manifest.devDependencies
  const scripts = manifest.scripts === undefined ? {} : manifest.scripts
  const languageService = resolveWorkspaceVersion(
    '@effect/language-service',
    development['@effect/language-service'],
    catalog,
  )
  if (manifest.pnpm !== undefined) {
    errors.push('package.json: pnpm settings belong in pnpm-workspace.yaml under pnpm 12')
  }
  if (languageService !== versions['@effect/language-service']) {
    errors.push(
      `package.json: @effect/language-service must resolve to ${versions['@effect/language-service']}`,
    )
  }
  if (scripts.prepare === undefined || !scripts.prepare.includes('effect-language-service patch')) {
    errors.push('package.json: prepare must patch TypeScript with effect-language-service')
  }
  if (scripts.lint === undefined || !scripts.lint.includes('--type-aware')) {
    errors.push('package.json: lint must enable Oxlint --type-aware analysis')
  }
  return errors
}

/** Report Effect language-service plugin drift in the shared TypeScript config. */
function typeScriptConfigErrors(root) {
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
  if (effectPlugin.ignoreEffectErrorsInTscExitCode !== false) {
    errors.push('tsconfig.base.json: Effect errors must fail typecheck')
  }
  if (effectPlugin.ignoreEffectWarningsInTscExitCode !== false) {
    errors.push('tsconfig.base.json: Effect warnings must fail typecheck')
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
    ...rootManifestErrors(rootManifest, catalog),
    ...typeScriptConfigErrors(root),
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

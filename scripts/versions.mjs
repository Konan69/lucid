#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

export const versions = Object.freeze({
  '@alchemy.run/better-auth': '2.0.0-beta.79',
  '@effect/language-service': '0.87.2',
  '@effect/platform-node': '4.0.0-rc.116',
  '@effect/sql-pg': '4.0.0-rc.116',
  '@effect/vitest': '4.0.0-rc.116',
  '@shadcn/lint': '0.1.1',
  '@typescript/native': 'npm:typescript@7.0.2',
  alchemy: '2.0.0-beta.79',
  'better-auth': '1.7.5',
  'drizzle-kit': '1.0.0-rc.5-ab785fc',
  'drizzle-orm': '1.0.0-rc.5-ab785fc',
  effect: '4.0.0-rc.116',
  oxlint: '1.83.0',
  'oxlint-tailwindcss': '1.12.0',
  pg: '^8.23.0',
  tailwindcss: '4.3.0',
  typescript: '6.0.3',
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
  'package.json': ['@effect/vitest', '@shadcn/lint', 'oxlint', 'oxlint-tailwindcss', 'vitest'],
  'apps/web/package.json': ['tailwindcss'],
  'apps/server/package.json': [
    '@alchemy.run/better-auth',
    '@effect/platform-node',
    '@effect/sql-pg',
    'alchemy',
    'better-auth',
    'drizzle-kit',
    'drizzle-orm',
    'effect',
    'pg',
  ],
  'packages/agent-runtime/package.json': ['drizzle-kit', 'drizzle-orm', 'effect', 'pg'],
  'packages/connectors/package.json': ['drizzle-kit', 'drizzle-orm', 'effect', 'pg'],
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
  compilerOptions: Schema.optionalKey(Schema.Struct({
    plugins: Schema.optionalKey(Schema.Array(Schema.Struct({
      name: Schema.String,
      diagnostics: Schema.optionalKey(Schema.Boolean),
      ignoreEffectErrorsInTscExitCode: Schema.optionalKey(Schema.Boolean),
      ignoreEffectWarningsInTscExitCode: Schema.optionalKey(Schema.Boolean),
    }))),
  })),
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
    if (!active || !line.startsWith('  ') || line.startsWith('    ') || line.trimStart().startsWith('#')) {
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

/** Validate dependency lockstep and the native TypeScript/Effect compiler path. */
export function validateVersions(root) {
  const errors = []
  const rootManifest = readPackageManifest(root, 'package.json')
  const catalog = readWorkspaceMapping(root, 'catalog')
  const overrides = readWorkspaceMapping(root, 'overrides')
  const manifests = [
    { relativePath: 'package.json', manifest: rootManifest },
    ...workspaceManifestPaths(root).map((relativePath) => ({
      relativePath,
      manifest: readPackageManifest(root, relativePath),
    })),
  ]

  for (const { relativePath, manifest } of manifests) {
    const sections = [
      { section: 'dependencies', dependencies: manifest.dependencies },
      { section: 'devDependencies', dependencies: manifest.devDependencies },
      { section: 'peerDependencies', dependencies: manifest.peerDependencies },
      { section: 'optionalDependencies', dependencies: manifest.optionalDependencies },
    ]
    for (const { section, dependencies } of sections) {
      if (dependencies === undefined) continue
      for (const [name, expected] of Object.entries(versions)) {
        const declared = dependencies[name]
        const actual = resolveWorkspaceVersion(name, declared, catalog)
        if (declared !== undefined && actual !== expected) {
          errors.push(`${relativePath}: ${section}.${name} must resolve to ${expected}; found ${declared}`)
        }
      }
    }

    const typecheck = manifest.scripts === undefined ? undefined : manifest.scripts.typecheck
    if (typecheck !== undefined && /(?:^|\s)tsc(?:\s|$)/u.test(typecheck)) {
      const nativeTypeScript = resolveWorkspaceVersion(
        '@typescript/native',
        manifest.devDependencies === undefined
          ? undefined
          : manifest.devDependencies['@typescript/native'],
        catalog,
      )
      if (nativeTypeScript !== versions['@typescript/native']) {
        errors.push(
          `${relativePath}: tsc typecheck must resolve @typescript/native ${versions['@typescript/native']}`,
        )
      }
      const toolingTypeScript = resolveWorkspaceVersion(
        'typescript',
        manifest.devDependencies === undefined ? undefined : manifest.devDependencies.typescript,
        catalog,
      )
      if (toolingTypeScript !== versions.typescript) {
        errors.push(`${relativePath}: tooling TypeScript must resolve to ${versions.typescript}`)
      }
    }
  }

  for (const [relativePath, names] of Object.entries(requiredByManifest)) {
    const manifest = readPackageManifest(root, relativePath)
    for (const name of names) {
      const production = manifest.dependencies === undefined ? undefined : manifest.dependencies[name]
      const development = manifest.devDependencies === undefined ? undefined : manifest.devDependencies[name]
      const declared = production ?? development
      const actual = resolveWorkspaceVersion(name, declared, catalog)
      if (actual !== versions[name]) {
        errors.push(
          `${relativePath}: ${name} must resolve to ${versions[name]}; found ${declared}`,
        )
      }
    }
  }

  for (const [name, expected] of Object.entries(forcedVersions)) {
    const declared = overrides[name]
    const actual = resolveWorkspaceVersion(name, declared, catalog)
    if (actual !== expected) {
      errors.push(
        `pnpm-workspace.yaml: overrides.${name} must resolve to ${expected}; found ${declared}`,
      )
    }
  }

  if (rootManifest.pnpm !== undefined) {
    errors.push('package.json: pnpm settings belong in pnpm-workspace.yaml under pnpm 12')
  }

  if (
    resolveWorkspaceVersion(
      '@effect/language-service',
      rootManifest.devDependencies === undefined
        ? undefined
        : rootManifest.devDependencies['@effect/language-service'],
      catalog,
    ) !== versions['@effect/language-service']
  ) {
    errors.push(
      `package.json: @effect/language-service must resolve to ${versions['@effect/language-service']}`,
    )
  }
  const prepare = rootManifest.scripts === undefined ? undefined : rootManifest.scripts.prepare
  if (prepare === undefined || !prepare.includes('effect-language-service patch')) {
    errors.push('package.json: prepare must patch TypeScript with effect-language-service')
  }
  const lint = rootManifest.scripts === undefined ? undefined : rootManifest.scripts.lint
  if (lint === undefined || !lint.includes('--type-aware')) {
    errors.push('package.json: lint must enable Oxlint --type-aware analysis')
  }

  const tsconfig = readTypeScriptConfig(root, 'tsconfig.base.json')
  const plugins = tsconfig.compilerOptions === undefined ? undefined : tsconfig.compilerOptions.plugins
  const effectPlugin = plugins === undefined
    ? undefined
    : plugins.find((plugin) => plugin.name === '@effect/language-service')
  if (effectPlugin === undefined) {
    errors.push('tsconfig.base.json: @effect/language-service plugin is required')
  } else {
    if (effectPlugin.diagnostics !== true) {
      errors.push('tsconfig.base.json: Effect diagnostics must be enabled')
    }
    if (effectPlugin.ignoreEffectErrorsInTscExitCode !== false) {
      errors.push('tsconfig.base.json: Effect errors must fail typecheck')
    }
    if (effectPlugin.ignoreEffectWarningsInTscExitCode !== false) {
      errors.push('tsconfig.base.json: Effect warnings must fail typecheck')
    }
  }

  return errors
}

const isMain = process.argv[1] !== undefined && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
  const errors = validateVersions(root)
  if (errors.length > 0) {
    process.stderr.write(`version lockstep failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('version lockstep passed\n')
  }
}

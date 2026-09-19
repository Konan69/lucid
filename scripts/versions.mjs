#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const versions = Object.freeze({
  '@alchemy.run/better-auth': '2.0.0-beta.79',
  '@effect/language-service': '0.87.2',
  '@effect/platform-node': '4.0.0-rc.116',
  '@effect/sql-pg': '4.0.0-rc.116',
  '@shadcn/lint': '0.1.1',
  '@typescript/native': 'npm:typescript@7.0.2',
  alchemy: '2.0.0-beta.79',
  'better-auth': '1.7.5',
  'drizzle-kit': '1.0.0-rc.5-ab785fc',
  'drizzle-orm': '1.0.0-rc.5-ab785fc',
  effect: '4.0.0-rc.116',
  oxlint: '1.81.0',
  'oxlint-tailwindcss': '1.12.0',
  pg: '^8.23.0',
  tailwindcss: '4.3.0',
  typescript: '6.0.3',
})

const forcedVersions = Object.freeze({
  '@effect/platform-node': versions['@effect/platform-node'],
  '@effect/sql-pg': versions['@effect/sql-pg'],
  'drizzle-kit': versions['drizzle-kit'],
  'drizzle-orm': versions['drizzle-orm'],
  effect: versions.effect,
})

const requiredByManifest = Object.freeze({
  'package.json': ['@shadcn/lint', 'oxlint', 'oxlint-tailwindcss'],
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

const readJson = (root, relativePath) =>
  JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'))

/** Read one flat mapping from pnpm-workspace.yaml without adding a bootstrap dependency. */
function readWorkspaceMapping(root, section) {
  const lines = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n')
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
    readdirSync(path.join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}/package.json`)
      .filter((relativePath) => {
        try {
          readFileSync(path.join(root, relativePath))
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
  const rootManifest = readJson(root, 'package.json')
  const catalog = readWorkspaceMapping(root, 'catalog')
  const overrides = readWorkspaceMapping(root, 'overrides')
  const manifests = [
    ['package.json', rootManifest],
    ...workspaceManifestPaths(root).map((relativePath) => [relativePath, readJson(root, relativePath)]),
  ]

  for (const [relativePath, manifest] of manifests) {
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    for (const section of sections) {
      for (const [name, expected] of Object.entries(versions)) {
        const declared = manifest[section]?.[name]
        const actual = resolveWorkspaceVersion(name, declared, catalog)
        if (declared !== undefined && actual !== expected) {
          errors.push(`${relativePath}: ${section}.${name} must resolve to ${expected}; found ${declared}`)
        }
      }
    }

    const typecheck = manifest.scripts?.typecheck
    if (typeof typecheck === 'string' && /(?:^|\s)tsc(?:\s|$)/u.test(typecheck)) {
      const nativeTypeScript = resolveWorkspaceVersion(
        '@typescript/native',
        manifest.devDependencies?.['@typescript/native'],
        catalog,
      )
      if (nativeTypeScript !== versions['@typescript/native']) {
        errors.push(
          `${relativePath}: tsc typecheck must resolve @typescript/native ${versions['@typescript/native']}`,
        )
      }
      const toolingTypeScript = resolveWorkspaceVersion(
        'typescript',
        manifest.devDependencies?.typescript,
        catalog,
      )
      if (toolingTypeScript !== versions.typescript) {
        errors.push(`${relativePath}: tooling TypeScript must resolve to ${versions.typescript}`)
      }
    }
  }

  for (const [relativePath, names] of Object.entries(requiredByManifest)) {
    const manifest = readJson(root, relativePath)
    for (const name of names) {
      const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
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
      rootManifest.devDependencies?.['@effect/language-service'],
      catalog,
    ) !== versions['@effect/language-service']
  ) {
    errors.push(
      `package.json: @effect/language-service must resolve to ${versions['@effect/language-service']}`,
    )
  }
  if (!rootManifest.scripts?.prepare?.includes('effect-language-service patch')) {
    errors.push('package.json: prepare must patch TypeScript with effect-language-service')
  }
  if (!rootManifest.scripts?.lint?.includes('--type-aware')) {
    errors.push('package.json: lint must enable Oxlint --type-aware analysis')
  }

  const tsconfig = readJson(root, 'tsconfig.base.json')
  const effectPlugin = tsconfig.compilerOptions?.plugins?.find(
    (plugin) => plugin.name === '@effect/language-service',
  )
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

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const errors = validateVersions(root)
  if (errors.length > 0) {
    process.stderr.write(`version lockstep failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('version lockstep passed\n')
  }
}

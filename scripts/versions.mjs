#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const versions = Object.freeze({
  '@alchemy.run/better-auth': '2.0.0-beta.79',
  '@effect/language-service': '0.87.2',
  '@effect/platform-node': '4.0.0-rc.116',
  '@effect/sql-pg': '4.0.0-rc.116',
  '@typescript/native': 'npm:typescript@7.0.2',
  alchemy: '2.0.0-beta.79',
  'better-auth': '1.7.5',
  'drizzle-kit': '1.0.0-rc.5-ab785fc',
  'drizzle-orm': '1.0.0-rc.5-ab785fc',
  effect: '4.0.0-rc.116',
  pg: '^8.23.0',
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
  const manifests = [
    ['package.json', rootManifest],
    ...workspaceManifestPaths(root).map((relativePath) => [relativePath, readJson(root, relativePath)]),
  ]

  for (const [relativePath, manifest] of manifests) {
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    for (const section of sections) {
      for (const [name, expected] of Object.entries(versions)) {
        const actual = manifest[section]?.[name]
        if (actual !== undefined && actual !== expected) {
          errors.push(`${relativePath}: ${section}.${name} must be ${expected}; found ${actual}`)
        }
      }
    }

    const typecheck = manifest.scripts?.typecheck
    if (typeof typecheck === 'string' && /(?:^|\s)tsc(?:\s|$)/u.test(typecheck)) {
      if (manifest.devDependencies?.['@typescript/native'] !== versions['@typescript/native']) {
        errors.push(
          `${relativePath}: tsc typecheck must resolve @typescript/native ${versions['@typescript/native']}`,
        )
      }
      if (manifest.devDependencies?.typescript !== versions.typescript) {
        errors.push(`${relativePath}: tooling TypeScript must be ${versions.typescript}`)
      }
    }
  }

  for (const [relativePath, names] of Object.entries(requiredByManifest)) {
    const manifest = readJson(root, relativePath)
    for (const name of names) {
      const actual = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
      if (actual !== versions[name]) {
        errors.push(`${relativePath}: ${name} must be present at ${versions[name]}; found ${actual}`)
      }
    }
  }

  for (const [name, expected] of Object.entries(forcedVersions)) {
    const actual = rootManifest.pnpm?.overrides?.[name]
    if (actual !== expected) {
      errors.push(`package.json: pnpm.overrides.${name} must be ${expected}; found ${actual}`)
    }
  }

  if (rootManifest.devDependencies?.['@effect/language-service'] !== versions['@effect/language-service']) {
    errors.push(
      `package.json: @effect/language-service must be ${versions['@effect/language-service']}`,
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

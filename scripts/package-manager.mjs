#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

export const packageManagerVersion = '12.4.2'
const ignoredDirectories = new Set([
  '.git',
  '.cache',
  '.output',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  // Untracked third-party reference checkouts; their lockfiles never resolve this workspace.
  'refs',
])
const foreignLockfiles = new Set(['package-lock.json', 'yarn.lock'])
const PackageManagerDocument = Schema.Struct({
  packageManager: Schema.String,
  engines: Schema.Struct({ pnpm: Schema.String }),
  pnpm: Schema.OptionFromOptionalKey(Schema.Unknown),
})
const decodePackageManagerDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageManagerDocument),
)

/** Find lockfiles that would let another package manager resolve a different dependency graph. */
export function findForeignLockfiles(root) {
  const found = []
  const pending = [root]

  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break

    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(NodePath.join(directory, entry.name))
      } else if (foreignLockfiles.has(entry.name)) {
        found.push(NodePath.relative(root, NodePath.join(directory, entry.name)))
      }
    }
  }

  return found.toSorted((left, right) => left.localeCompare(right))
}

/** Enforce the repository's package-manager pin and pnpm 12 configuration ownership. */
export function validatePackageManager(root) {
  const errors = []
  const manifest = decodePackageManagerDocument(
    NodeFS.readFileSync(NodePath.join(root, 'package.json'), 'utf8'),
  )
  const workspace = NodeFS.readFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'utf8')

  if (manifest.packageManager !== `pnpm@${packageManagerVersion}`) {
    errors.push(`package.json: packageManager must be pnpm@${packageManagerVersion}`)
  }
  if (manifest.engines.pnpm !== packageManagerVersion) {
    errors.push(`package.json: engines.pnpm must be ${packageManagerVersion}`)
  }
  if (Option.isSome(manifest.pnpm)) {
    errors.push('package.json: pnpm 12 project settings belong in pnpm-workspace.yaml')
  }
  if (!/^autoInstallPeers: false$/mu.test(workspace)) {
    errors.push('pnpm-workspace.yaml: autoInstallPeers must be false')
  }
  if (!/^strictPeerDependencies: true$/mu.test(workspace)) {
    errors.push('pnpm-workspace.yaml: strictPeerDependencies must be true')
  }
  if (!/^verifyDepsBeforeRun: false$/mu.test(workspace)) {
    errors.push('pnpm-workspace.yaml: verifyDepsBeforeRun must be false')
  }
  if (!/^allowBuilds:$/mu.test(workspace)) {
    errors.push('pnpm-workspace.yaml: allowBuilds must classify dependency build scripts')
  }
  if (!/^patchedDependencies:$/mu.test(workspace)) {
    errors.push('pnpm-workspace.yaml: patchedDependencies must own repository patches')
  }
  for (const lockfile of findForeignLockfiles(root)) {
    errors.push(`${lockfile}: remove foreign lockfile; this repository is pnpm-only`)
  }

  return errors
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
if (isMain) {
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
  const errors = validatePackageManager(root)
  if (errors.length > 0) {
    process.stderr.write(
      `package-manager policy failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`,
    )
    process.exitCode = 1
  } else {
    process.stdout.write('package-manager policy passed\n')
  }
}

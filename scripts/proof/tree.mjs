import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

/** A failed checkout must abort before any reversal can run. */
function git(root, args) {
  const result = NodeChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`proof scratch: ${result.stderr.trim()}`)
  return result.stdout
}

/** External dependencies stay warm; workspace links point into the disposable clone. */
function linkDependencies(source, target, roots) {
  if (!NodeFS.existsSync(source)) return
  NodeFS.mkdirSync(target, { recursive: true })
  for (const entry of NodeFS.readdirSync(source)) {
    if (entry === '.cache' || entry === '.vite') continue
    const from = NodePath.join(source, entry)
    const to = NodePath.join(target, entry)
    if (entry.startsWith('@')) {
      linkDependencies(from, to, roots)
      continue
    }
    const real = NodeFS.realpathSync(from)
    const relative = NodePath.relative(roots.source, real)
    const workspace = !relative.startsWith('..') && !relative.includes('node_modules')
    NodeFS.symlinkSync(workspace ? NodePath.join(roots.target, relative) : real, to)
  }
}

/** Cloning avoids changing the caller's index, refs, worktree registrations or source files. */
export function scratchTree(root, directory, sha) {
  const target = NodePath.join(directory, 'tree')
  git(root, ['clone', '--quiet', '--shared', '--no-checkout', root, target])
  git(target, ['checkout', '--quiet', '--detach', sha])
  const manifests = git(target, ['ls-files', '-z', '--', 'package.json', '**/package.json'])
    .split('\0')
    .filter(Boolean)
  for (const manifest of manifests) {
    const packagePath = NodePath.dirname(manifest)
    linkDependencies(
      NodePath.join(root, packagePath, 'node_modules'),
      NodePath.join(target, packagePath, 'node_modules'),
      { source: root, target },
    )
  }
  return target
}

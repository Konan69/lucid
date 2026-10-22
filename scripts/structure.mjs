import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { parseSync } from 'oxc-parser'
import { walk } from './syntax.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
const multipleWords = /[-_]|[a-z][A-Z]/u
const dumpingGround = /^(utils|helpers|common|shared|misc)$/u

export const sourceStructure = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const file = NodePath.relative(context.cwd, context.filename).split(NodePath.sep).join('/')
    if (!/\.tsx?$/u.test(file)) return {}
    if (!/^(?:apps\/[^/]+|packages\/[^/]+(?:\/[^/]+)?)\/src\//u.test(file)) return {}
    return {
      Program(node) {
        const name = NodePath.basename(file).replace(/\.tsx?$/u, '')
        if (multipleWords.test(name))
          context.report({ node, message: 'Use a one-word source filename.' })
        if (file.endsWith('.ts') && dumpingGround.test(name))
          context.report({ node, message: 'Name the module for its domain responsibility.' })
      },
      ImportDeclaration(node) {
        const value =
          node.importKind !== 'type' &&
          (node.specifiers.length === 0 ||
            node.specifiers.some((specifier) => specifier.importKind !== 'type'))
        if (!value) return
        if (
          /^apps\/server\/src\/[^/]+\/handlers\.ts$/u.test(file) &&
          /^drizzle-orm(?:\/|$)/u.test(node.source.value)
        )
          context.report({ node, message: 'Handlers hold no SQL. Call the owning store.' })
        if (
          /^apps\/server\/src\/[^/]+\/store\.ts$/u.test(file) &&
          /^effect\/(?:rpc|http-api|http)\//u.test(node.source.value)
        )
          context.report({
            node,
            message: 'Stores hold no transport. Return the domain result to the handler.',
          })
      },
    }
  },
}

export default { meta: { name: 'vivid-structure' }, rules: { source: sourceStructure } }

export function directoryErrors(repository) {
  const failures = []
  for (const first of NodeFS.readdirSync(NodePath.join(repository, 'packages'), {
    withFileTypes: true,
  })) {
    if (!first.isDirectory() || first.name === 'node_modules') continue
    if (multipleWords.test(first.name))
      failures.push(`packages/${first.name}: use a one-word package directory`)
    for (const second of NodeFS.readdirSync(NodePath.join(repository, 'packages', first.name), {
      withFileTypes: true,
    })) {
      if (second.isDirectory() && second.name !== 'node_modules' && multipleWords.test(second.name))
        failures.push(`packages/${first.name}/${second.name}: use a one-word package directory`)
    }
  }
  return failures
}

export function directiveErrors(file, source) {
  const { comments, program } = parseSync(file, source, { astType: 'ts' })
  const suppressed = comments.some(({ value }) => {
    const directive = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)(.*)$/su.exec(
      value,
    )
    if (directive === null) return false
    const rules = directive[1].split('--')[0].trim()
    return rules === '' || rules.split(/[,\s]+/u).includes('vivid-structure/source')
  })
  if (!suppressed) return []
  const failures = []
  const visitors = sourceStructure.create({
    cwd: root,
    filename: NodePath.join(root, file),
    report: ({ message }) => failures.push(`${file}: ${message}`),
  })
  walk(program, (node) => {
    const visitor = visitors[node.type]
    if (visitor !== undefined) visitor(node)
  })
  return failures
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const failures = directoryErrors(root)
  const files = NodeChildProcess.execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0')
  for (const file of files) {
    if (!/^(?:apps\/[^/]+|packages\/[^/]+(?:\/[^/]+)?)\/src\/.*\.tsx?$/u.test(file)) continue
    if (!NodeFS.existsSync(NodePath.join(root, file))) continue
    failures.push(...directiveErrors(file, NodeFS.readFileSync(NodePath.join(root, file), 'utf8')))
  }
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, 'node_modules/oxlint/bin/oxlint'),
      '--config',
      'scripts/structure.json',
      '--threads=1',
      '--disable-nested-config',
      'apps',
      'packages',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  process.exitCode = failures.length === 0 && result.status === 0 ? 0 : 1
}

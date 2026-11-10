import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as YAML from 'yaml'
import * as Schema from 'effect/Schema'
import { blockedCommands, isCompilerBlocker } from './bins.mjs'

const forbidden = /(?<![\w.-])(?:tsc|tsgo|tsserver)(?:\.(?:[cm]?js|cmd))?(?![\w/-])/u
const compilerPackages = new Set([
  'typescript',
  '@typescript/native',
  '@effect/tsgo',
  '@effect/language-service',
])

const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
const Manifest = Schema.Struct({
  scripts: Dependencies,
  dependencies: Dependencies,
  devDependencies: Dependencies,
  peerDependencies: Dependencies,
  optionalDependencies: Dependencies,
})
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

function packageErrors(file, manifest) {
  const commands = Object.entries(manifest.scripts ?? {}).flatMap(([name, command]) =>
    forbidden.test(command) ? [`${file}: scripts.${name} must use scripts/types.mjs`] : [],
  )
  const dependencies = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ].flatMap((section) =>
    Object.keys(manifest[section] ?? {}).flatMap((name) =>
      compilerPackages.has(name)
        ? [`${file}: remove ${section}.${name}; use the pinned tsc-rs`]
        : [],
    ),
  )
  return commands.concat(dependencies)
}

export function commandErrors(file, source) {
  if (NodePath.basename(file) === 'package.json') return packageErrors(file, decodeManifest(source))
  if (file.startsWith('.husky/'))
    return forbidden.test(source) ? [`${file}: compiler commands must use scripts/types.mjs`] : []
  const prose = source
    .replace(
      /\b(?:never|do not|don't)\s+(?:run|use|execute|invoke)\s+(`+)(?:tsc|tsgo|tsserver)\1/giu,
      '',
    )
    .replace(/(?:,\s*not\s+|\binstead of\s+)(`+)(?:tsc|tsgo|tsserver)\1/giu, '')
  const commands = [...prose.matchAll(/(`+)([^`]+)\1/gu)].flatMap((match) =>
    match[1].length >= 3 || !/^(?:tsc|tsgo|tsserver)$/u.test(match[2]) ? [match[2]] : [],
  )
  const instructions = prose
    .split('\n')
    .filter(
      (line) =>
        /\b(?:run|use|execute|invoke)\b/iu.test(line) ||
        /^(?: {4}|\t)/u.test(line) ||
        /(?<![\w.-])(?:tsc|tsgo|tsserver)\s+-/u.test(line) ||
        /^\s*(?:[$>]\s*|[-*]\s+|\d+[.)]\s+)?(?:tsc|tsgo|tsserver)(?:\s+-|$)/u.test(line),
    )
  return [...commands, ...instructions].some((command) => forbidden.test(command))
    ? [`${file}: document pnpm check with a project path`]
    : []
}

function compilerPolicy(root) {
  const files = NodeChildProcess.execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
  const failures = []
  for (const file of new Set(files)) {
    if (!NodeFS.existsSync(NodePath.join(root, file))) continue
    if (
      NodePath.basename(file) === 'package.json' ||
      file.startsWith('.husky/') ||
      /\.(?:md|mdx)$/iu.test(file)
    )
      failures.push(...commandErrors(file, NodeFS.readFileSync(NodePath.join(root, file), 'utf8')))
  }
  const documents = YAML.parseAllDocuments(
    NodeFS.readFileSync(NodePath.join(root, 'pnpm-lock.yaml'), 'utf8'),
  )
  const packages = documents.flatMap((document) => Object.keys(document.toJS().packages ?? {}))
  for (const name of packages)
    if (/^(?:typescript|@typescript\/native|@effect\/tsgo|@effect\/language-service)@/u.test(name))
      failures.push(`pnpm-lock.yaml: remove ${name}; compiler peers must stay uninstalled`)
  for (const file of files.filter((candidate) => NodePath.basename(candidate) === 'package.json'))
    for (const name of blockedCommands) {
      const bin = NodePath.join(root, NodePath.dirname(file), 'node_modules/.bin', name)
      if (NodeFS.existsSync(bin) && !isCompilerBlocker(root, bin))
        failures.push(
          `${file}: ${name} bin is reachable; reinstall without legacy compiler packages`,
        )
    }
  return failures
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const failures = compilerPolicy(process.cwd())
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  process.stdout.write(`compiler policy: ${failures.length} violations\n`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { isStringLiteral, parseSource, sourcePositions, walk } from '../syntax.mjs'
import { deadCodeRatchets } from './ratchets.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..', '..')

/** The properties whose string a deploy target runs as a command (Railway and Alchemy Command). */
const commandKeys = new Set(['command', 'preDeploy', 'preDeployCommand', 'startCommand'])

/**
 * What makes a command a shell program rather than one program with its arguments. On Railway the
 * server's pre-deploy was `node scripts/migrate.mjs server && node apps/cells/scripts/build.mjs
 * deploy`, and in 59 deploys from 30 October 2026 the publish half never ran, so every Person's
 * cell kept a Worker that refused every send. How the launcher split that string was never read
 * back; a command that is one program has nothing to split.
 */
const shellSyntax = [
  ['&&', /&&/u],
  ['||', /\|\|/u],
  [';', /;/u],
  ['|', /\|/u],
  // `exec` only as the command itself; `pnpm exec` is a subcommand, not the shell's.
  ['exec', /^\s*exec\s/u],
  ['sh -c', /\b(?:ba|z)?sh\s+-c\b/u],
]

const fix =
  'Make the step one program with its arguments (`node scripts/<step>.mjs`) that runs its parts in order, reads each result back and exits non-zero when any part fails, or make each part its own Alchemy resource.'

/**
 * The static text of a string or template literal; undefined for anything computed. A Property's
 * key and value are always nodes, and an array hole is null, which matches neither type.
 */
const staticText = (node) => {
  if (node !== null && isStringLiteral(node)) return node.value
  if (node !== null && node.type === 'TemplateLiteral')
    return node.quasis.map((quasi) => quasi.value.cooked).join('')
  return undefined
}

const keyName = (property) =>
  property.key.type === 'Identifier' ? property.key.name : staticText(property.key)

const shellFinding = (text) => shellSyntax.find(([, pattern]) => pattern.test(text))

/** Findings in one TypeScript deploy definition: every command property whose text is a shell chain. */
export function scanDefinition(file, source) {
  const position = sourcePositions(source)
  const findings = []
  walk(parseSource(file, source), (node) => {
    if (node.type !== 'Property' || !commandKeys.has(keyName(node))) return
    const values = node.value.type === 'ArrayExpression' ? node.value.elements : [node.value]
    for (const value of values) {
      const text = staticText(value)
      const found = text === undefined ? undefined : shellFinding(text)
      if (found === undefined) continue
      const { line } = position(value.start)
      findings.push(
        `${file}:${line}: \`${keyName(node)}\` is a shell chain (\`${found[0]}\`). ${fix}`,
      )
    }
  })
  return findings
}

/**
 * Findings in one Dockerfile: a `CMD` or `ENTRYPOINT` in shell form, or an exec form that starts a
 * shell. `RUN` is left alone: it runs while the image is built, under a real shell, and a failing
 * part fails the build.
 */
export function scanDockerfile(file, source) {
  // One instruction per logical line: a trailing backslash continues it, so the `CMD` of a
  // `HEALTHCHECK` on the next physical line stays part of the `HEALTHCHECK`.
  const instructions = []
  source.split('\n').forEach((text, index) => {
    const open = instructions.at(-1)
    if (open !== undefined && open.continues) {
      open.text += ` ${text}`
      open.continues = text.endsWith('\\')
      return
    }
    instructions.push({ line: index + 1, text, continues: text.endsWith('\\') })
  })
  return instructions.flatMap(({ line, text }) => {
    const instruction = /^\s*(CMD|ENTRYPOINT)\s+(.*)$/iu.exec(text)
    if (instruction === null) return []
    const [, name, argument] = instruction
    const exec = argument.trimStart().startsWith('[')
    const words = exec ? argument.replaceAll(/[[\]",]/gu, ' ') : argument
    const found = exec ? shellFinding(words) : ['shell form', /./u]
    if (found === undefined) return []
    return [
      `${file}:${line}: \`${name}\` runs a shell (\`${found[0]}\`). Use the exec form, one program: \`${name} ["node", "..."]\`. ${fix}`,
    ]
  })
}

/** The tracked deploy definitions: the Alchemy stack, its infra modules and every Dockerfile. */
function definitions(directory) {
  const tracked = NodeChildProcess.execFileSync('git', ['ls-files', '-z'], {
    cwd: directory,
    encoding: 'utf8',
  })
  return tracked
    .split('\0')
    .filter(
      (file) =>
        file === 'alchemy.run.ts' ||
        /^infra\/.+\.ts$/u.test(file) ||
        /(?:^|\/)Dockerfile(?:\.[\w-]+)?$/u.test(file),
    )
}

function scanCommands(directory) {
  return definitions(directory).flatMap((file) => {
    const source = NodeFS.readFileSync(NodePath.join(directory, file), 'utf8')
    return file.endsWith('.ts') ? scanDefinition(file, source) : scanDockerfile(file, source)
  })
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const findings = scanCommands(root)
  const ceiling = deadCodeRatchets.find((entry) => entry.plugin === 'deploy').ceiling
  if (findings.length !== ceiling) {
    findings.forEach((finding) => process.stderr.write(`${finding}\n`))
    process.stderr.write(
      `deploy/shell-chain: ${findings.length} findings; ceiling ${ceiling}. Fix new ones; lower scripts/gate/ratchets.mjs when one is fixed.\n`,
    )
    process.exitCode = 1
  }
}

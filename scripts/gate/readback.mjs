import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { isStringLiteral, parseSource, sourcePositions, walk } from '../syntax.mjs'
import { deadCodeRatchets } from './ratchets.mjs'

const root = NodeURL.fileURLToPath(new URL('../../', import.meta.url))
const key = (property) =>
  property.key.type === 'Identifier' ? property.key.name : property.key.value
const property = (object, name) =>
  object.properties.find((entry) => entry.type === 'Property' && key(entry) === name)

/** The pre-deploy runner consumes one exported table; every step must name its read-back. */
export function scanPredeploy(file, source) {
  const program = parseSource(file, source)
  const tables = []
  walk(program, (node) => {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration === null) return
    if (node.declaration.type !== 'VariableDeclaration') return
    for (const entry of node.declaration.declarations)
      if (entry.id.name === 'predeploySteps' && entry.init.type === 'ArrayExpression')
        tables.push(entry.init)
  })
  if (tables.length !== 1)
    return [`${file}: export one predeploySteps table with a readBack for every deploy step.`]
  return tables[0].elements.flatMap((step) => {
    if (step === null || step.type !== 'ObjectExpression')
      return [`${file}: declare each deploy step and its readBack explicitly.`]
    const readBack = property(step, 'readBack')
    if (
      readBack !== undefined &&
      isStringLiteral(readBack.value) &&
      readBack.value.value.trim().length > 0
    )
      return []
    const name = property(step, 'name')
    const label = name !== undefined && isStringLiteral(name.value) ? name.value.value : 'step'
    return [
      `${file}: ${label} writes outside Alchemy and has no readBack. Declare the result the next step or readiness check reads.`,
    ]
  })
}

/** Custom providers must be observable; finite Command/Action effects cannot own production work. */
export function scanResources(file, source) {
  const program = parseSource(file, source)
  const position = sourcePositions(source)
  const findings = []
  const report = (node, message) =>
    findings.push(`${file}:${position(node.start).line}: ${message}`)
  walk(program, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return
    const callee = node.callee
    if (callee.object.name !== 'Provider' || !['succeed', 'effect'].includes(callee.property.name))
      return
    const implementation = node.arguments[1]
    let readable = false
    walk(implementation, (entry) => {
      if (entry.type === 'Property' && key(entry) === 'read') readable = true
    })
    if (!readable)
      report(
        node,
        'custom resource has no read. Add a provider read that observes its live result.',
      )
  })
  walk(program, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.name !== 'railwayStack') return
    walk(node.init, (entry) => {
      if (entry.type !== 'CallExpression') return
      const callee = entry.callee
      const exec =
        callee.type === 'MemberExpression' &&
        callee.object.name === 'Command' &&
        callee.property.name === 'Exec'
      const action =
        callee.name === 'Action' ||
        (callee.type === 'MemberExpression' && callee.property.name === 'Action')
      if (exec || action)
        report(
          entry,
          'railwayStack writes outside Alchemy without read-back. Use a resource with read instead of Command.Exec or Action.',
        )
    })
  })
  return findings
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const files = NodeChildProcess.execFileSync(
    'git',
    ['ls-files', '-z', 'infra', 'alchemy.run.ts'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter((file) => file.endsWith('.ts'))
  const findings = files.flatMap((file) =>
    scanResources(file, NodeFS.readFileSync(NodePath.join(root, file), 'utf8')),
  )
  findings.push(
    ...scanPredeploy(
      'infra/predeploy.mjs',
      NodeFS.readFileSync(NodePath.join(root, 'infra/predeploy.mjs'), 'utf8'),
    ),
  )
  const ceiling = deadCodeRatchets.find((entry) => entry.plugin === 'readback').ceiling
  if (findings.length !== ceiling) {
    findings.forEach((finding) => process.stderr.write(`${finding}\n`))
    process.stderr.write(
      `readback/missing: ${findings.length} findings; ceiling ${ceiling}. Give every deploy step a read-back; lower scripts/gate/ratchets.mjs when one is fixed.\n`,
    )
    process.exitCode = 1
  }
}

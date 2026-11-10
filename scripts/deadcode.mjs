import * as NodeChildProcess from 'node:child_process'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import { Result, Schema } from 'effect'
import { deadCodeRatchets } from './gate/ratchets.mjs'

// Run the pinned binary directly so pnpm banners cannot corrupt the JSON receipt.
const require = NodeModule.createRequire(import.meta.url)
const binary = NodePath.join(NodePath.dirname(require.resolve('knip/package.json')), 'bin/knip.js')
const result = NodeChildProcess.spawnSync(process.execPath, [binary, '--reporter', 'json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})
if (result.error !== undefined) throw result.error
if (result.status !== 0 && result.status !== 1) {
  process.stderr.write(result.stderr)
  throw new Error(`knip failed with status ${result.status}; findings were not measured`)
}
const Receipt = Schema.Struct({
  issues: Schema.Array(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.Json)])),
  ),
})
const { issues } = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Receipt))(result.stdout),
)
const counts = new Map(
  deadCodeRatchets.filter((entry) => entry.plugin === 'knip').map((entry) => [entry.rule, 0]),
)
for (const issue of issues) {
  for (const [kind, findings] of Object.entries(issue)) {
    if (!Array.isArray(findings) || findings.length === 0) continue
    if (!counts.has(kind)) throw new Error(`knip: unratcheted issue kind ${kind}`)
    counts.set(kind, counts.get(kind) + findings.length)
    for (const finding of findings)
      process.stdout.write(`${issue.file}: knip/${kind}: ${JSON.stringify(finding)}\n`)
  }
}
for (const { plugin, rule, ceiling } of deadCodeRatchets.filter(
  (entry) => entry.plugin === 'knip',
)) {
  const count = counts.get(rule)
  process.stdout.write(`${plugin}/${rule}: ${count} findings, ceiling ${ceiling}\n`)
  if (count !== ceiling) {
    process.stderr.write(
      `${plugin}/${rule}: ${count > ceiling ? 'new unused code; wire it up or delete it' : `lower ceiling to ${count} in scripts/gate/ratchets.mjs`}\n`,
    )
    process.exitCode = 1
  }
}

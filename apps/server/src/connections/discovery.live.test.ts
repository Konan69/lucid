import * as NodeFS from 'node:fs'
import { describe, expect, it } from '@effect/vitest'
import { Config, Effect, Schema } from 'effect'
import { chainFixture, chainLayer, completeRun, toolParts } from '../runtime/chains.ts'
import { proofConnection } from './proof.ts'

const Found = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ account: Schema.String, tool: Schema.String, effect: Schema.String }),
  ),
})

/** Ask the real Vivid to discover, without dispatching a write: the provider receipt proves
 * ordering and a single Decision receipt proves that runtime discovery reached relevance.
 * Two real tools remain candidates because both match the Proof Records Integration name.
 * Neither a direct FindTools RPC nor a direct relevance-model call proves this claim.
 */
const decodeFound = Schema.decodeUnknownEffect(Found)

describe.skipIf(process.env['VIVID_LIVE_DISCOVERY'] !== '1')('Tool discovery runtime proof', () => {
  it.live(
    'returns the relevant save tool first and logs one measured decision',
    () =>
      Effect.gen(function* () {
        expect(yield* Config.String('VIVID_DECISIONS')).toBe('on')
        const logPath = yield* Config.NonEmptyString('VIVID_PROOF_SERVER_LOG')
        const evidence = yield* Config.NonEmptyString('VIVID_PROOF_EVIDENCE')
        const fixture = yield* chainFixture('Discovery proof')
        const connection = yield* proofConnection(fixture)
        const offset = yield* Effect.sync(() => NodeFS.readFileSync(logPath, 'utf8').length)
        const runId = yield* fixture.send(
          'Find the tool in my Proof Records integration that saves a new record. Show the available tools, but do not call any of them yet.',
        )
        // Retain the real receipt even when runtime settlement or later assertions fail.
        yield* Effect.sync(() =>
          console.log(
            JSON.stringify({ claim: 'C4', threadId: fixture.threadId, runId, phase: 'Submitted' }),
          ),
        )
        const settled = yield* completeRun(fixture, runId)
        const parts = toolParts(settled)
        const discovery = parts.filter(
          (part) => part.toolName === 'find_tools' && part.state === 'output-available',
        )
        expect(discovery).toHaveLength(1)
        const part = discovery[0]
        if (part === undefined || part.state !== 'output-available')
          return yield* Effect.sync(() => expect.fail('No real discovery receipt'))
        const found = yield* decodeFound(part.output)
        const records = yield* connection.records()
        const detail = yield* fixture.rpc.GetThread({ id: fixture.threadId })
        const logs = yield* Effect.sync(() => NodeFS.readFileSync(logPath, 'utf8').slice(offset))
        const lines = logs.match(/(?:Decision|Tool relevance unavailable) \{[^}]*\}/gu) ?? []
        const result = {
          claim: 'C4',
          threadId: fixture.threadId,
          runId,
          order: found.tools,
          records,
          approvals: detail.approvals.map((item) => ({ id: item.id, state: item.state._tag })),
          tools: parts.map((tool) => ({ name: tool.toolName, state: tool.state })),
          lines,
        }
        yield* Effect.sync(() => {
          NodeFS.writeFileSync(
            `${evidence}/discovery.json`,
            JSON.stringify({ ...result, messages: settled.messages }, null, 2),
            { mode: 0o600 },
          )
          console.log(JSON.stringify(result))
        })
        expect(found.tools.map((tool) => tool.tool)).toEqual(['mutations.save', 'queries.records'])
        expect(lines.filter((line) => line.startsWith('Decision {'))).toHaveLength(1)
        expect(lines[0]).toMatch(/latency: \d+, inputTokens: \d+, outputTokens: \d+/u)
        expect(records).toEqual([])
        expect(detail.approvals).toEqual([])
        return yield* Effect.void
      }).pipe(Effect.scoped, Effect.provide(chainLayer)),
    { timeout: 180_000 },
  )
})

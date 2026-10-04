import * as NodeFS from 'node:fs'
import { describe, expect, it } from '@effect/vitest'
import { Clock, Config, Effect, Option, Schema } from 'effect'
import { proofConnection } from '../connections/proof.ts'
import {
  chainFixture,
  chainLayer,
  completeRun,
  replyText,
  toolParts,
  waitForState,
} from '../runtime/chains.ts'

const Saved = Schema.Struct({
  ok: Schema.Literal(true),
  output: Schema.Struct({ saved: Schema.Literal(true), subject: Schema.String }),
})
const decodedSave = Schema.decodeUnknownOption(Saved)

/** Real signup, private Thread and Executor storage; each sample starts with fresh ownership.
 * The wall time ends at the first storage read after the streamed write receipt, before the
 * final model reply. This is observed existence, including SSE and storage-read overhead.
 * Log windows belong to the serial proof stack and assert review rather than inferring it
 * from a completed write, which would also pass if Reviewer silently returned Unreviewed.
 */
describe.skipIf(process.env['VIVID_LIVE_INTENT'] !== '1')('Asked write decisions on', () => {
  for (const sample of [1, 2, 3]) {
    it.live(
      `saves the asked-for record, sample ${sample}`,
      () =>
        Effect.gen(function* () {
          expect(yield* Config.String('VIVID_DECISIONS')).toBe('on')
          const logPath = yield* Config.NonEmptyString('VIVID_PROOF_SERVER_LOG')
          const evidence = yield* Config.NonEmptyString('VIVID_PROOF_EVIDENCE')
          const fixture = yield* chainFixture('Intent proof')
          const connection = yield* proofConnection(fixture)
          expect(yield* connection.records()).toEqual([])
          const offset = yield* Effect.sync(() => NodeFS.readFileSync(logPath, 'utf8').length)
          const started = yield* Clock.currentTimeMillis
          const runId = yield* fixture.send(
            'In my Proof Records integration, save a record whose subject is "Intent runtime verified". Discover the tool, then call use_tool directly. Do not use a program.',
          )
          // Retain the real receipt even when runtime settlement or later assertions fail.
          yield* Effect.sync(() =>
            console.log(
              JSON.stringify({
                claim: 'C1/C5',
                threadId: fixture.threadId,
                runId,
                phase: 'Submitted',
              }),
            ),
          )
          const receipt = yield* waitForState(
            fixture.conversation,
            (state) =>
              toolParts(state).some(
                (part) => part.toolName === 'use_tool' && part.state === 'output-available',
              ) || state.settlements.some((settled) => settled.submissionId === runId),
          )
          const records = yield* connection.records()
          const observedMillis = (yield* Clock.currentTimeMillis) - started
          const settled = yield* completeRun(fixture, runId)
          const detail = yield* fixture.rpc.GetThread({ id: fixture.threadId })
          const logs = yield* Effect.sync(() => NodeFS.readFileSync(logPath, 'utf8').slice(offset))
          const lines =
            logs.match(/(?:Action reviewed|Action unreviewed|Decision) \{[^}]*\}/gu) ?? []
          const saved = toolParts(receipt).some(
            (part) =>
              part.toolName === 'use_tool' &&
              part.state === 'output-available' &&
              Option.isSome(decodedSave(part.output)),
          )
          const result = {
            claim: 'C1/C5',
            sample,
            threadId: fixture.threadId,
            runId,
            observedMillis,
            records,
            approvals: detail.approvals.map((item) => ({ id: item.id, state: item.state._tag })),
            tools: toolParts(settled).map((part) => ({ name: part.toolName, state: part.state })),
            lines,
          }
          yield* Effect.sync(() => {
            NodeFS.writeFileSync(
              `${evidence}/intent-${sample}.json`,
              JSON.stringify({ ...result, messages: settled.messages }, null, 2),
              { mode: 0o600 },
            )
            console.log(JSON.stringify(result))
          })
          expect(saved, 'The streamed receipt must confirm the actual save').toBe(true)
          expect(records.map((record) => record.subject)).toEqual(['Intent runtime verified'])
          expect(detail.approvals).toEqual([])
          expect(replyText(settled).length).toBeGreaterThan(0)
          expect(lines.filter((line) => line.startsWith('Action reviewed'))).toHaveLength(1)
        }).pipe(Effect.scoped, Effect.provide(chainLayer)),
      { timeout: 180_000 },
    )
  }
})

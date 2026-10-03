import { describe, expect, it } from '@effect/vitest'
import { ApprovalDecision, ApprovalState, RunState } from '@vivid/contracts'
import { Effect } from 'effect'
import { proofConnection } from '../connections/proof.ts'
import {
  chainFixture,
  chainLayer,
  completeRun,
  replyText,
  toolParts,
  waitForState,
} from '../runtime/chains.ts'

/** One real model proposal plus its required outcome delivery; no judges or retry attempts. */
describe.skipIf(process.env['VIVID_LIVE_THREAD_APPROVAL'] !== '1')(
  'Thread Approval live chain',
  () => {
    it.live(
      'proposes, approves the stored action, saves once and reports its outcome',
      () =>
        Effect.gen(function* () {
          const fixture = yield* chainFixture('Approval chain proof')
          const connection = yield* proofConnection(fixture)
          expect(yield* connection.records()).toEqual([])
          const runId = yield* fixture.send(
            'In my Proof Records integration, save a record whose subject is "Approval chain verified". Discover the tool, then call use_tool directly. Do not use a program. Ask me for approval if needed.',
          )
          const initial = yield* completeRun(fixture, runId)
          expect(
            toolParts(initial).some(
              (part) => part.toolName === 'use_tool' && part.state === 'output-available',
            ),
          ).toBe(true)
          const detail = yield* fixture.rpc.GetThread({ id: fixture.threadId })
          const approval = detail.approvals.find((item) => ApprovalState.guards.Pending(item.state))
          if (approval === undefined)
            return yield* Effect.sync(() => expect.fail('The real model must raise an Approval'))
          expect(yield* connection.records(), 'Nothing runs before the Person approves').toEqual([])
          const decision = yield* fixture.rpc.DecideApproval({
            id: approval.id,
            digest: approval.digest,
            decision: ApprovalDecision.cases.AllowOnce.make({}),
          })
          expect(ApprovalState.guards.Succeeded(decision.approval.state)).toBe(true)
          expect((yield* connection.records()).map((record) => record.subject)).toEqual([
            'Approval chain verified',
          ])
          const resumed = yield* waitForState(
            fixture.conversation,
            (state) => state.settlements.length > initial.settlements.length,
          )
          expect(replyText(resumed)).toMatch(/Approval chain verified|saved|record/i)
          const finished = yield* fixture.rpc.GetThread({ id: fixture.threadId })
          expect(
            finished.runs.some((run) => run.id !== runId && RunState.guards.Completed(run.state)),
          ).toBe(true)
          expect(
            (yield* connection.records()).length,
            'The resumed model must not replay the action',
          ).toBe(1)
        }).pipe(Effect.scoped, Effect.provide(chainLayer)),
      { timeout: 240_000 },
    )
  },
)

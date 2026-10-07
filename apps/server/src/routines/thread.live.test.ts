import { describe, expect, layer } from '@effect/vitest'
import { createFlueClient } from '@flue/sdk'
import { RoutineTrigger, RunState } from '@vivid/contracts'
import { Effect, Option, Stream } from 'effect'
import { ExecutorCallOutcome } from '../connections/executor.ts'
import { proofConnection } from '../connections/proof.ts'
import { chainFixture, chainLayer, replyText, waitForState } from '../runtime/chains.ts'

/** The production polling worker observes a new committed Executor record and admits one model Run.
 * The service is an isolated real Executor deployment; this does not establish Google event parity.
 */
describe.skipIf(process.env['VIVID_LIVE_THREAD_ROUTINE'] !== '1')(
  'Thread Integration Routine live chain',
  () => {
    layer(chainLayer, { excludeTestServices: true })((it) => {
      it.effect(
        'polls a real service record created after its baseline and starts a Run',
        () =>
          Effect.gen(function* () {
            const fixture = yield* chainFixture('Integration event proof')
            const connection = yield* proofConnection(fixture)
            const { routine } = yield* fixture.rpc.CreateRoutine({
              name: 'Observe proof records',
              prompt:
                'Report the subject of the newly arrived record in one sentence. Do not call tools.',
              trigger: RoutineTrigger.cases.Integration.make({
                account: 'Proof Records',
                event: 'queries.records',
                filter: {
                  input: {},
                  itemsPath: [],
                  idPath: ['id'],
                  newestFirst: false,
                  intervalMinutes: 1,
                },
              }),
              libraryFolderId: null,
            })
            expect(yield* connection.records()).toEqual([])
            const created = yield* connection.executor.call({
              references: connection.references,
              tool: 'mutations.save',
              input: { subject: 'Routine event verified' },
            })
            expect(ExecutorCallOutcome.guards.Completed(created)).toBe(true)
            // The production scheduler owns its private Thread; the live receipt tells us where to observe.
            const delivered = yield* fixture.rpc.WatchRoutines().pipe(
              Stream.map((value) => value.routines.find((item) => item.id === routine.id)),
              Stream.filter(
                (value) =>
                  value !== undefined && value.runs.some((run) => run.status === 'succeeded'),
              ),
              Stream.runHead,
            )
            if (Option.isNone(delivered) || delivered.value === undefined)
              return yield* Effect.sync(() => expect.fail('The event must settle an Occurrence'))
            const occurrence = delivered.value.runs[0]
            if (occurrence === undefined)
              return yield* Effect.sync(() =>
                expect.fail('A real Integration event must create an Occurrence Thread'),
              )
            const conversation = createFlueClient({
              url: new URL(`/api/vivid/${occurrence.threadId}`, fixture.server).href,
              headers: { cookie: fixture.cookie },
            })
            const state = yield* waitForState(conversation, (value) => value.settlements.length > 0)
            expect(replyText(state)).toContain('Routine event verified')
            const detail = yield* fixture.rpc.GetThread({ id: occurrence.threadId })
            expect(detail.runs.some((run) => RunState.guards.Completed(run.state))).toBe(true)
            expect(delivered.value.runs).toHaveLength(1)
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    })
  },
)

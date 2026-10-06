import { expect, it } from '@effect/vitest'
import { Option, Schema } from 'effect'
import { emptyRound, type Desk } from './calls.ts'
import { initialRunState, type Chunk } from './chunks.ts'
import { CallLookup } from './holds.ts'
import { writeStep } from './stream.ts'

/** Task identities arrive from the trusted Pi snapshot; the unit desk models that exact ingress. */
const decodeTask = Schema.decodeUnknownSync(CallLookup.cases.Ready.fields.taskId)
const decodeHold = Schema.decodeUnknownSync(CallLookup.cases.Ready.fields.holdId)
const ready = (callId: string) =>
  CallLookup.cases.Ready.make({
    taskId: decodeTask(callId === 'c1' ? 1 : 2),
    holdId: decodeHold(callId === 'c1' ? 'hold:1' : 'hold:2'),
    callId,
  })
const desk: Desk = {
  plan: () => Option.some({ approval: () => true, source: 'server' }),
  call: ready,
  origin: () => Option.none(),
  hold: () => CallLookup.cases.Missing.make({}),
}

// A live allocation must not finish a response while a second call's input is still incomplete.
it('waits for event settlement when a live frame releases incomplete withheld calls', () => {
  const inputs: readonly Chunk[] = [
    { type: 'tool-input-start', toolCallId: 'c1', toolName: 'pay' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'pay', input: { amount: 1 } },
    { type: 'tool-input-start', toolCallId: 'c2', toolName: 'pay' },
  ]
  const queued = writeStep(
    { state: initialRunState, round: emptyRound, settled: false },
    { state: initialRunState, chunks: inputs },
    false,
    { ...desk, call: () => CallLookup.cases.Queued.make({}) },
  )
  const live = writeStep(queued, { state: queued.state, chunks: [] }, queued.settled, desk)
  expect(live.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toHaveLength(1)
  expect(live.round.started.has('c2')).toBe(true)
  expect(live.round.available.has('c2')).toBe(false)
  expect(live.ended).toBe(false)
  expect(live.chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
  const settled = writeStep(
    live,
    {
      state: live.state,
      chunks: [
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'pay', input: { amount: 2 } },
      ],
    },
    true,
    desk,
  )
  expect(settled.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toHaveLength(1)
  expect(settled.round.awaiting).toEqual(new Set(['c1', 'c2']))
  expect(settled.ended).toBe(true)
})

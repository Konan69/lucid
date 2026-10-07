import { expect, it } from '@effect/vitest'
import { Effect, Option, Schema, Stream } from 'effect'
import { fauxAssistantMessage, fauxText, fauxThinking } from '@earendil-works/pi-ai/providers/faux'
import { emptyRound, type Desk } from './calls.ts'
import { initialRunState, translate, type Chunk } from './chunks.ts'
import { consume } from './fixtures/reading.ts'
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
  sequential: false,
  plan: () =>
    Option.some({
      approval: () => true,
      source: 'server',
      execution: 'parallel',
      dynamic: false,
      title: Option.none(),
    }),
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

/** A replacement cannot retract one SDK delta. Reset/rebuild its step and retain earlier steps;
 * exercise both Pi replacement shapes and both SDK append-only part kinds through the real reader. */
for (const kind of ['text', 'thinking'] as const)
  for (const change of ['block', 'message'] as const)
    it.live(
      `retracts shorter ${kind} from a ${change} replacement without losing prior steps`,
      () =>
        Effect.gen(function* () {
          const prefix = fauxText('Prefix.')
          const target = kind === 'text' ? fauxText('Final.\n\n') : fauxThinking('Final.\n\n')
          const final = kind === 'text' ? fauxText('Final.') : fauxThinking('Final.')
          const message = fauxAssistantMessage([prefix, target])
          const replacement = fauxAssistantMessage([prefix, final])
          const opened = translate(initialRunState, { type: 'message_start', message })
          const replaced = translate(opened.state, {
            type: 'message_update',
            usage: message.usage,
            changes:
              change === 'block'
                ? [{ type: 'block', contentIndex: 1, block: final }]
                : [{ type: 'message', message: replacement }],
          })
          const previous: readonly Chunk[] = [
            { type: 'start' },
            { type: 'start-step' },
            { type: 'text-start', id: 'earlier' },
            { type: 'text-delta', id: 'earlier', delta: 'Earlier.' },
            { type: 'text-end', id: 'earlier' },
            { type: 'finish-step' },
            { type: 'start-step' },
          ]
          const ending: readonly Chunk[] = [{ type: 'finish-step' }, { type: 'finish' }]
          const live = yield* consume(
            Stream.fromIterable([...previous, ...opened.chunks, ...replaced.chunks, ...ending]),
            Option.none(),
          )
          const captured = translate(initialRunState, {
            type: 'message_start',
            message: replacement,
          })
          const replay = yield* consume(
            Stream.fromIterable([...previous, ...captured.chunks, ...ending]),
            Option.none(),
          )
          expect(live.chunks.filter((chunk) => chunk.type === 'reset-step')).toHaveLength(1)
          expect(live.message.parts).toEqual(replay.message.parts)
          expect(live.message.parts.flatMap((part) => ('text' in part ? [part.text] : []))).toEqual(
            ['Earlier.', 'Prefix.', 'Final.'],
          )
        }),
    )

import type { FlueConversationMessage } from '@flue/sdk'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  decodeHeard,
  encodeHeard,
  heardAt,
  settledOf,
  TAIL,
  THREADS,
  withHeard,
  type Heard,
} from './heard.ts'

const ADA = { origin: 'https://vivid.example', person: PersonId.make('ada') }
const NOTHING = Option.none<Heard>()
const thread = (n: number) =>
  ThreadId.make(`2f0c1a54-1f4e-4c0e-9a39-0d6f3d1f7a${String(n).padStart(2, '0')}`)

const said = (
  id: string,
  text: string,
  state: 'streaming' | 'done' = 'done',
): FlueConversationMessage => ({
  id,
  role: 'assistant',
  purpose: 'assistant',
  display: 'visible',
  parts: [{ type: 'text', text, state }],
})
const asked = (id: string, text: string, submissionId: string): FlueConversationMessage => ({
  ...said(id, text),
  role: 'user',
  purpose: 'user',
  submissionId,
})
const ids = (messages: ReadonlyArray<FlueConversationMessage>) => messages.map(({ id }) => id)

describe('what a Thread last said', () => {
  it('comes back from the file as it was kept, tools and files included', () => {
    const messages: ReadonlyArray<FlueConversationMessage> = [
      { ...asked('m1', 'Find the invoice', 's1'), timestamp: '2026-10-10T22:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        purpose: 'assistant',
        display: 'visible',
        turnId: 't1',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'search',
            toolCallId: 'c1',
            state: 'output-available',
            input: { q: 'invoice' },
            output: [1, 2],
            durationMs: 40,
          },
          { type: 'file', mediaType: 'application/pdf', filename: 'invoice.pdf' },
          { type: 'data-chart', data: { rows: 3 } },
          { type: 'text', text: 'Here it is.', state: 'done' },
        ],
      },
    ]
    const kept = withHeard(NOTHING, ADA, { thread: thread(1), messages, at: 1 })
    const read = decodeHeard(Option.getOrThrow(encodeHeard(kept)))
    expect(Option.getOrThrow(heardAt(read, ADA, thread(1)))).toEqual(messages)
  })

  it('keeps nothing of an answer that is still being written, nor what follows it', () => {
    const messages = [said('m1', 'Done.'), said('m2', 'Half an ans', 'streaming'), said('m3', 'x')]
    expect(ids(settledOf({ messages, settlements: [] }))).toEqual(['m1'])
  })

  it('keeps the question and not the answer while its submission has not ended', () => {
    // Every part is finished, as it is between two steps, and Vivid is still answering.
    const messages = [
      asked('m1', 'One', 's1'),
      { ...said('m2', 'First answer'), submissionId: 's1' },
      asked('m3', 'Two', 's2'),
      { ...said('m4', 'Looking'), submissionId: 's2' },
    ]
    const ended = [{ submissionId: 's1' }]
    expect(ids(settledOf({ messages, settlements: ended }))).toEqual(['m1', 'm2', 'm3'])
    expect(ids(settledOf({ messages, settlements: [...ended, { submissionId: 's2' }] }))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ])
  })

  it('keeps only the newest messages of a long Thread', () => {
    const messages = Array.from({ length: TAIL + 5 }, (_, n) => said(`m${n}`, 'x'))
    const kept = settledOf({ messages, settlements: [] })
    expect(kept).toHaveLength(TAIL)
    expect(ids(kept).at(-1)).toBe(`m${TAIL + 4}`)
  })

  it('lets go of the Thread kept longest ago once there are too many', () => {
    const all = Array.from({ length: THREADS + 1 }, (_, n) => n).reduce(
      (kept, n) =>
        Option.some(withHeard(kept, ADA, { thread: thread(n), messages: [said('m', 'x')], at: n })),
      NOTHING,
    )
    expect(Option.isNone(heardAt(all, ADA, thread(0)))).toBe(true)
    expect(Option.isSome(heardAt(all, ADA, thread(THREADS)))).toBe(true)
  })

  it('is drawn only for the Person it was kept for, and is dropped when another is heard', () => {
    const bea = { ...ADA, person: PersonId.make('bea') }
    const elsewhere = { ...ADA, origin: 'https://other.example' }
    const hers = Option.some(
      withHeard(NOTHING, ADA, { thread: thread(1), messages: [said('m', 'x')], at: 1 }),
    )
    expect(Option.isNone(heardAt(hers, bea, thread(1)))).toBe(true)
    expect(Option.isNone(heardAt(hers, elsewhere, thread(1)))).toBe(true)
    const next = withHeard(hers, bea, { thread: thread(2), messages: [said('m', 'y')], at: 2 })
    expect(Object.keys(next.threads)).toEqual([thread(2)])
  })

  it('reads text in a shape it does not know as nothing kept', () => {
    expect(Option.isNone(decodeHeard('{"whose":{"origin":"x"},"threads":{}}'))).toBe(true)
  })
})

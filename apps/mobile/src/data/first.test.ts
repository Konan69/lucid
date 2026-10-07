import type { FlueConversationMessage } from '@flue/sdk'
import { ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  again,
  begin,
  First,
  firstKey,
  isOnItsWay,
  isSettled,
  startedWith,
  makeFirsts,
  withFirst,
  type Start,
  type Way,
} from './first.ts'

const id = ThreadId.make('6f0d3c7e-2a55-4d0b-9c61-0d6f3a1b2c4e')
const start: Start = { words: 'Book the flight', projectId: null, at: 1000, place: 'fresh' }

/** A way to the server that answers as told and records what was asked of it, in order. */
const wayThat = (answers: { make: Option.Option<string>; say: Option.Option<string> }) => {
  const asked: Array<string> = []
  const way: Way = {
    make: () => {
      asked.push('make')
      return Promise.resolve(answers.make)
    },
    say: () => {
      asked.push('say')
      return Promise.resolve(answers.say)
    },
    returned: () => asked.push('returned'),
    taken: () => asked.push('taken'),
  }
  return { way, asked }
}

const said = (
  key: string,
  role: FlueConversationMessage['role'],
  text: string,
): FlueConversationMessage => ({
  id: key,
  role,
  purpose: role === 'assistant' ? 'assistant' : 'user',
  display: 'visible',
  parts: [{ type: 'text', text, state: 'done' }],
})

describe('a Thread started from the greeting', () => {
  it('is on its way at once, and with Vivid once made and spoken in', async () => {
    const firsts = makeFirsts()
    const { way, asked } = wayThat({ make: Option.none(), say: Option.none() })
    const sent = begin(way, firsts, id, start)
    expect(firsts.of(id)).toEqual(Option.some(First.Sending({ start })))
    await sent
    expect(asked).toEqual(['make', 'say', 'taken'])
    expect(firsts.of(id)).toEqual(Option.some(First.Said({ start })))
  })

  it('gives the words back when the Thread could not be made, and makes it on the next try', async () => {
    const firsts = makeFirsts()
    const refused = wayThat({ make: Option.some('Offline'), say: Option.none() })
    await begin(refused.way, firsts, id, start)
    expect(refused.asked).toEqual(['make', 'returned'])
    expect(firsts.of(id)).toEqual(Option.some(First.Unsent({ start, born: false, why: 'Offline' })))
    const open = wayThat({ make: Option.none(), say: Option.none() })
    await again(open.way, firsts, id)
    expect(open.asked).toEqual(['make', 'say', 'taken'])
  })

  it('never makes a second Thread when only the words did not arrive', async () => {
    const firsts = makeFirsts()
    const lost = wayThat({ make: Option.none(), say: Option.some('No answer') })
    await begin(lost.way, firsts, id, start)
    expect(firsts.of(id)).toEqual(
      Option.some(First.Unsent({ start, born: true, why: 'No answer' })),
    )
    const open = wayThat({ make: Option.none(), say: Option.none() })
    await again(open.way, firsts, id)
    expect(open.asked).toEqual(['say', 'taken'])
    expect(firsts.of(id)).toEqual(Option.some(First.Said({ start })))
  })

  it('sends nothing again for words that are not in doubt', async () => {
    const firsts = makeFirsts()
    const { way, asked } = wayThat({ make: Option.none(), say: Option.none() })
    await begin(way, firsts, id, start)
    asked.length = 0
    await again(way, firsts, id)
    expect(asked).toEqual([])
  })

  it('is asked about only once its first words are with Vivid', () => {
    expect(isSettled(Option.none())).toBe(true)
    expect(isSettled(Option.some(First.Sending({ start })))).toBe(false)
    expect(isSettled(Option.some(First.Unsent({ start, born: true, why: 'x' })))).toBe(false)
    expect(isSettled(Option.some(First.Said({ start })))).toBe(true)
  })
})

describe('first words on their way', () => {
  it('counts them from the send until the Thread has spoken for itself', () => {
    expect(isOnItsWay(Option.some(First.Sending({ start })), false)).toBe(true)
    expect(isOnItsWay(Option.some(First.Said({ start })), false)).toBe(true)
    expect(isOnItsWay(Option.some(First.Said({ start })), true)).toBe(false)
  })

  it('does not count words that did not arrive, or a Thread started elsewhere', () => {
    expect(isOnItsWay(Option.some(First.Unsent({ start, born: false, why: 'x' })), false)).toBe(
      false,
    )
    expect(isOnItsWay(Option.none(), false)).toBe(false)
  })
})

describe('a conversation with its first words', () => {
  const unread = (messages: ReadonlyArray<FlueConversationMessage>) => ({ messages, ready: false })
  const read = (messages: ReadonlyArray<FlueConversationMessage>) => ({ messages, ready: true })

  it('is left alone when it was not started here', () => {
    const messages = [said('a', 'user', 'Hello')]
    expect(withFirst(id, Option.none(), read(messages))).toBe(messages)
  })

  it('shows the words before the conversation has any of its own', () => {
    const shown = withFirst(id, Option.some(First.Sending({ start })), unread([]))
    expect(shown.map((message) => [message.id, message.role])).toEqual([[firstKey(id), 'user']])
    expect(shown.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'Book the flight', state: 'done' }],
    ])
  })

  it('keeps the words under the key they were drawn with when they come back, and adds none', () => {
    const shown = withFirst(
      id,
      Option.some(First.Said({ start })),
      read([
        said('server-1', 'user', 'Book the flight'),
        said('server-2', 'assistant', 'On it'),
        said('server-3', 'user', 'Thanks'),
      ]),
    )
    expect(shown.map((message) => message.id)).toEqual([firstKey(id), 'server-2', 'server-3'])
  })

  it('keeps the words first when more is said before the history has been read', () => {
    const shown = withFirst(
      id,
      Option.some(First.Said({ start })),
      unread([said('local-1', 'user', 'And a hotel')]),
    )
    expect(shown.map((message) => message.id)).toEqual([firstKey(id), 'local-1'])
  })

  it('takes the first message of a read history for the words when none says the same', () => {
    const shown = withFirst(
      id,
      Option.some(First.Said({ start })),
      read([said('server-1', 'user', 'Book the flight.'), said('server-2', 'assistant', 'On it')]),
    )
    expect(shown.map((message) => message.id)).toEqual([firstKey(id), 'server-2'])
  })

  it('does not draw the words twice when the conversation opens with something else', () => {
    const shown = withFirst(
      id,
      Option.some(First.Said({ start })),
      read([said('server-1', 'assistant', 'On it')]),
    )
    expect(shown.map((message) => message.id)).toEqual(['server-1'])
  })
})

describe('words sent again from the composer they were typed in', () => {
  const other = ThreadId.make('00000000-0000-4000-8000-0000000000ff')
  const unsent = First.Unsent({ start, born: true, why: 'x' })

  it('go on as the Thread they already started', () => {
    const firsts = new Map([[id, unsent]])
    expect(startedWith(firsts, start.words, start.place)).toEqual(Option.some(id))
  })

  it('start a new Thread when the first one has them, or they are other words', () => {
    expect(
      startedWith(new Map([[other, First.Said({ start })]]), start.words, start.place),
    ).toEqual(Option.none())
    expect(startedWith(new Map([[id, unsent]]), 'Something else', start.place)).toEqual(
      Option.none(),
    )
  })
})

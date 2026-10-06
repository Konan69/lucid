import {
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  PersonId,
  ServiceId,
  type Connection,
} from '@vivid/contracts'
import { describe, expect, it } from 'vitest'
import { bind, forget, leave, refused, settled, type Wish, type Wishes } from './wish.ts'

const gmail = ServiceId.make('gmail')
const begun = ConnectionId.make('begun')
const NONE: Wishes = new Map()

/** The account a press ended in. Which account it is, is not what these tests are about. */
const connected: Connection = {
  id: begun,
  service: gmail,
  serviceName: 'Gmail',
  mark: null,
  name: null,
  identity: null,
  account: 'Gmail',
  origin: 'Catalogue',
  ownership: ConnectionOwnership.cases.Personal.make({
    owner: { id: PersonId.make('ada'), name: 'Ada Obi', image: null },
  }),
  state: ConnectionState.cases.Ready.make({}),
  createdAt: 1,
}

/** A wish that lapses at 1000 and records, by name, that it was called. */
const wishOf = (name: string, called: Array<string>): Pick<Wish, 'until' | 'go'> => ({
  until: 1000,
  go: () => {
    called.push(name)
  },
})

/** Calls what a press ending under `key` at `now` answers, and gives back what is still waiting. */
const end = (wishes: Wishes, key: Parameters<typeof settled>[1], now: number): Wishes => {
  const { call, rest } = settled(wishes, key, now)
  for (const wish of call) wish.go(connected)
  return rest
}

describe('what a card wants done once its account is connected', () => {
  it('is answered once, by the press that carried the card', () => {
    const called: Array<string> = []
    const waiting = bind(leave(NONE, 'card', wishOf('card', called)), 'card', gmail)
    const after = end(waiting, gmail, 500)
    expect(called).toEqual(['card'])
    // A second account connected on the same service finds nothing left to answer.
    end(after, gmail, 600)
    expect(called).toEqual(['card'])
  })

  it('is never answered while no press carries the card', () => {
    const called: Array<string> = []
    // The card asked for a name and the form was dismissed: the wish was left and never bound.
    const waiting = leave(NONE, 'card', wishOf('card', called))
    // An account is then added on that service from the Integrations page.
    const after = end(waiting, gmail, 500)
    expect(called).toEqual([])
    expect(after.size).toBe(1)
  })

  it('is one wish for a card, however often the card is pressed', () => {
    const called: Array<string> = []
    // The first press begins an account on the service; the Person comes back without finishing.
    const first = bind(leave(NONE, 'card', wishOf('first', called)), 'card', gmail)
    // The second press picks that account up, and is filed under it.
    const second = bind(leave(first, 'card', wishOf('second', called)), 'card', begun)
    expect(second.size).toBe(1)
    // Another account on the service answers nothing: the wish moved with the card.
    const after = end(second, gmail, 500)
    expect(called).toEqual([])
    end(after, begun, 600)
    expect(called).toEqual(['second'])
  })

  it('is not answered after the Person carried on by hand', () => {
    const called: Array<string> = []
    const waiting = bind(leave(NONE, 'card', wishOf('card', called)), 'card', gmail)
    // The live list said the account was ready first, and "Carry on" was pressed on the card.
    end(forget(waiting, 'card'), gmail, 500)
    expect(called).toEqual([])
  })

  it('lapses, and is gone once its press has ended', () => {
    const called: Array<string> = []
    const waiting = bind(leave(NONE, 'card', wishOf('card', called)), 'card', gmail)
    const after = end(waiting, gmail, 1001)
    expect(called).toEqual([])
    expect(after.size).toBe(0)
  })

  it('is dropped with a press that was refused, and leaves other cards’ wishes alone', () => {
    const called: Array<string> = []
    const both = bind(
      bind(
        leave(leave(NONE, 'one', wishOf('one', called)), 'two', wishOf('two', called)),
        'one',
        gmail,
      ),
      'two',
      begun,
    )
    const after = refused(both, gmail)
    expect([...after.keys()]).toEqual(['two'])
    end(after, begun, 500)
    expect(called).toEqual(['two'])
  })

  it('binds nothing for a card that left no wish', () => {
    expect(bind(NONE, 'card', gmail).size).toBe(0)
  })
})

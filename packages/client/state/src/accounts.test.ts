import {
  ConnectionAuthorization,
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  PersonId,
  ServiceId,
  type Connection,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  accountWords,
  answered,
  asksName,
  Awaited,
  awaitedOf,
  awaitedWords,
  begunFor,
  byService,
  nameTaken,
  typedAccountName,
  whichAccount,
} from './accounts.ts'

const ada = { id: PersonId.make('ada'), name: 'Ada Obi', image: null }
const mine = ConnectionOwnership.cases.Personal.make({ owner: ada })
const ready = ConnectionState.cases.Ready.make({})
const unfinished = ConnectionState.cases.NeedsAuthorization.make({})

/** One account on a service, as the server sends it; only what a test is about is said. */
const account = (id: string, service: string, said: Partial<Connection> = {}): Connection => ({
  id: ConnectionId.make(id),
  service: ServiceId.make(service),
  serviceName: service,
  mark: null,
  name: null,
  identity: null,
  account: service,
  origin: 'Catalogue',
  ownership: mine,
  state: ready,
  createdAt: 1,
  ...said,
})

const request = { service: ServiceId.make('gmail') }

describe('the accounts a Person has, by service', () => {
  it('keeps a service where its first account put it, and lists its accounts oldest first', () => {
    // As the server sends them: newest first.
    const groups = byService([
      account('home', 'gmail', { createdAt: 30 }),
      account('wiki', 'deepwiki', { createdAt: 20 }),
      account('work', 'gmail', { createdAt: 10 }),
    ])
    // DeepWiki was connected after Gmail, so it leads; Gmail does not jump above it because a
    // second Gmail account was added later. Inside Gmail the first account stays first.
    expect(groups.map((group) => [group.service, group.accounts.map((item) => item.id)])).toEqual([
      ['deepwiki', ['wiki']],
      ['gmail', ['work', 'home']],
    ])
  })

  it('lists the Person’s own accounts before the Company’s on the same service', () => {
    const shared = ConnectionOwnership.cases.Shared.make({})
    const groups = byService([
      account('company', 'gmail', { ownership: shared, createdAt: 1 }),
      account('own', 'gmail', { createdAt: 2 }),
    ])
    expect(groups.map((group) => group.accounts.map((item) => item.id))).toEqual([
      ['own', 'company'],
    ])
  })

  it('draws the service’s icon from whichever account carries one', () => {
    const groups = byService([
      account('a', 'acme'),
      account('b', 'acme', { mark: 'https://icons.example/?domain=acme.test' }),
    ])
    expect(groups.map((group) => group.mark)).toEqual(['https://icons.example/?domain=acme.test'])
  })
})

describe('the words that say which account a row is', () => {
  it('are what the Person called it, then who the service says it is', () => {
    expect(accountWords({ name: 'Work', identity: 'ada@example.com' })).toEqual(
      Option.some('Work · ada@example.com'),
    )
    expect(accountWords({ name: 'Work', identity: null })).toEqual(Option.some('Work'))
    expect(accountWords({ name: null, identity: 'ada@example.com' })).toEqual(
      Option.some('ada@example.com'),
    )
    expect(accountWords({ name: null, identity: null })).toEqual(Option.none())
  })

  it('fall back to what Vivid calls the account only when it is one of several', () => {
    const unnamed = { name: null, identity: null, account: 'DeepWiki (2)', state: ready }
    expect(whichAccount(unnamed, true)).toEqual(Option.none())
    expect(whichAccount(unnamed, false)).toEqual(Option.some('DeepWiki (2)'))
    // A sign-in that was never finished is no account yet: it is not given Vivid's name for one.
    expect(whichAccount({ ...unnamed, state: unfinished }, false)).toEqual(Option.none())
  })
})

describe('asking a Person to name the account they are about to add', () => {
  it('never asks about the first account on a service', () => {
    expect(asksName([])).toBe(false)
  })

  it('asks when no account already there says who it is', () => {
    expect(asksName([account('a', 'github')])).toBe(true)
    expect(asksName([account('a', 'github', { name: 'Work' })])).toBe(true)
  })

  it('does not ask where the service says who signed in', () => {
    expect(asksName([account('a', 'gmail', { identity: 'ada@example.com' })])).toBe(false)
  })

  it('knows a name another account on the service already has, whatever its case', () => {
    const others = [account('a', 'github', { name: 'Work' }), account('b', 'github')]
    expect(nameTaken(others, Option.some('work '))).toBe(true)
    expect(nameTaken(others, Option.some('Personal'))).toBe(false)
    expect(nameTaken(others, Option.none())).toBe(false)
  })

  it('reads what was typed as a name: trimmed, one line, and none when nothing was typed', () => {
    expect(typedAccountName('  Work  ')).toEqual(Option.some('Work'))
    expect(typedAccountName('Work\naccount')).toEqual(Option.some('Work account'))
    expect(typedAccountName('   ')).toEqual(Option.none())
    expect(Option.map(typedAccountName('x'.repeat(60)), (name) => name.length)).toEqual(
      Option.some(40),
    )
  })
})

describe('what a card in a Thread is waiting for', () => {
  const card = { kind: 'connection-request', service: 'gmail', serviceName: 'Gmail', reason: 'r' }

  it('is the service, for a service Vivid offered', () => {
    expect(awaitedOf({ ...card, ready: false })).toEqual(Awaited.Service())
  })

  it('is the Integration Vivid began, when the card carries what finishing it takes', () => {
    const authorization = ConnectionAuthorization.cases.OpenSignIn.make({
      connectionId: ConnectionId.make('begun'),
    })
    expect(awaitedOf({ ...card, ready: false, authorization })).toEqual(
      Awaited.Begun({ id: ConnectionId.make('begun') }),
    )
  })

  it('is one more account, when the card carries the moment Vivid asked', () => {
    expect(awaitedOf({ ...card, ready: false, another: { askedAt: 500 } })).toEqual(
      Awaited.Another({ askedAt: 500 }),
    )
  })

  it('is answered by any ready account on the service when Vivid offered the service', () => {
    expect(answered([account('a', 'gmail')], request, Awaited.Service())).toBe(true)
    expect(
      answered([account('a', 'gmail', { state: unfinished })], request, Awaited.Service()),
    ).toBe(false)
    expect(answered([account('a', 'drive')], request, Awaited.Service())).toBe(false)
  })

  it('is answered only by the Integration Vivid began, not another on the same service', () => {
    const begun = Awaited.Begun({ id: ConnectionId.make('begun') })
    expect(answered([account('other', 'gmail')], request, begun)).toBe(false)
    expect(answered([account('other', 'gmail'), account('begun', 'gmail')], request, begun)).toBe(
      true,
    )
  })

  it('is not answered by the accounts that were there when Vivid asked for one more', () => {
    const another = Awaited.Another({ askedAt: 500 })
    const before = account('home', 'gmail', { createdAt: 100 })
    expect(answered([before], request, another)).toBe(false)
    expect(answered([before, account('work', 'gmail', { createdAt: 900 })], request, another)).toBe(
      true,
    )
    // One more account on another service is not the account that was asked for.
    expect(answered([before, account('d', 'drive', { createdAt: 900 })], request, another)).toBe(
      false,
    )
    // Begun after Vivid asked and not finished yet: still being waited for.
    expect(
      answered(
        [before, account('work', 'gmail', { createdAt: 900, state: unfinished })],
        request,
        another,
      ),
    ).toBe(false)
  })

  it('picks up what was begun for it and begins afresh otherwise', () => {
    const another = Awaited.Another({ askedAt: 500 })
    const before = account('home', 'gmail', { createdAt: 100 })
    const pending = account('work', 'gmail', { createdAt: 900, state: unfinished })
    // The account already there is not picked up: pressing must begin a second one.
    expect(begunFor([before], request, another)).toEqual(Option.none())
    expect(begunFor([before, pending], request, another)).toEqual(Option.some(pending.id))
    expect(begunFor([], request, Awaited.Begun({ id: ConnectionId.make('begun') }))).toEqual(
      Option.some(ConnectionId.make('begun')),
    )
    expect(begunFor([pending], request, Awaited.Service())).toEqual(Option.some(pending.id))
  })

  it('says it wants another account, where the service is already connected', () => {
    expect(awaitedWords(Awaited.Service(), 'Gmail').connect).toBe('Connect Gmail')
    const another = awaitedWords(Awaited.Another({ askedAt: 1 }), 'Gmail')
    expect(another.connect).toBe('Add another Gmail account')
    expect(another.title).toBe('Another Gmail account')
    expect(another.carryOn).toBe('Another Gmail account is connected. Carry on.')
  })
})

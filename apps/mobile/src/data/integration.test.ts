import {
  ConnectionAuthorization,
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  PersonId,
  ServiceAuthorization,
  ServiceId,
  type Connection,
  type Service,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { byPurpose } from '../screen/integration/purpose.ts'
import {
  accountLine,
  afterPress,
  Finish,
  finishOf,
  finishOfStep,
  marksOf,
  named,
  noteOf,
  type Presses,
} from './integration.ts'

const ada = { id: PersonId.make('ada'), name: 'Ada Obi', image: null }

const mine = ConnectionOwnership.cases.Personal.make({ owner: ada })

/** What tells an account apart, as the server sends it. */
type Said = Pick<Connection, 'name' | 'identity' | 'account'>
/** The Person called it "Work"; the service does not say who signed in. */
const work: Said = { name: 'Work', identity: null, account: 'Linear (Work)' }

/** One account on Linear, written out whole: who it is, whose it is and how it stands. */
const held = (
  id: string,
  said: Said,
  ownership: ConnectionOwnership,
  state: ConnectionState,
): Connection => ({
  id: ConnectionId.make(id),
  service: ServiceId.make('linear'),
  serviceName: 'Linear',
  mark: null,
  name: said.name,
  identity: said.identity,
  account: said.account,
  origin: 'Catalogue',
  ownership,
  state,
  createdAt: 1,
})

/** The Person's own account called "Work", standing as given. */
const account = (id: string, state: ConnectionState): Connection => held(id, work, mine, state)

/** What a card carries for an Integration Vivid began adding, which here wants a key. */
const started = ConnectionAuthorization.cases.EnterKey.make({
  connectionId: ConnectionId.make('started'),
  fields: [{ name: 'api_key', label: 'API key' }],
})

describe('what is left to do to finish an Integration', () => {
  it('is what the card was handed, until the server has been asked', () => {
    expect(finishOf(Option.some(started), Option.none())).toEqual(
      Option.some(
        Finish.Key({
          id: ConnectionId.make('started'),
          fields: [{ name: 'api_key', label: 'API key' }],
        }),
      ),
    )
  })

  it('is what the server says once it has been asked, when that differs from the card', () => {
    const signIn = ConnectionStep.cases.OpenSignIn.make({
      connection: account('started', ConnectionState.cases.NeedsAuthorization.make({})),
      address: 'https://linear.example/authorize?state=new',
    })
    // The address is not carried: it is asked for at the moment the page is opened.
    expect(finishOf(Option.some(started), Option.some(finishOfStep(signIn)))).toEqual(
      Option.some(Finish.SignIn({ id: ConnectionId.make('started') })),
    )
  })

  it('is nothing once the server says it went through', () => {
    const done = ConnectionStep.cases.Done.make({
      connection: account('started', ConnectionState.cases.Ready.make({})),
    })
    expect(finishOf(Option.some(started), Option.some(finishOfStep(done)))).toEqual(
      Option.some(Finish.Done()),
    )
  })

  it('is not this card’s to finish when the service was only offered from the catalogue', () => {
    expect(finishOf(Option.none(), Option.none())).toEqual(Option.none())
  })
})

/** One catalog entry, entered the given way. */
const offered = (
  name: string,
  authorization: ServiceAuthorization,
  mark: string | null = null,
): Service => ({
  id: ServiceId.make(name.toLowerCase()),
  name,
  description: 'Written by whoever published it',
  mark,
  authorization,
})

const ready = ConnectionState.cases.Ready.make({})
const unfinished = ConnectionState.cases.NeedsAuthorization.make({})

const unnamed: Said = { name: null, identity: null, account: 'Linear (2)' }

/** A row with nothing pressed, for the only account on its service unless said otherwise. */
const facts = { alone: true, sharedWith: Option.none<string>(), pressed: Option.none() }

describe('a connected account’s row on the Integrations sheet', () => {
  it('says which account it is once it works: its name, and who the service says it is', () => {
    expect(accountLine(account('a', ready), facts)).toBe('Work')
    expect(
      accountLine(
        held(
          'a',
          { name: 'Work', identity: 'ada@example.com', account: 'Linear (Work)' },
          mine,
          ready,
        ),
        facts,
      ),
    ).toBe('Work · ada@example.com')
    expect(
      accountLine(
        held('a', { name: null, identity: 'ada@example.com', account: 'Linear' }, mine, ready),
        facts,
      ),
    ).toBe('ada@example.com')
  })

  it('says it is connected when nothing tells it apart and it is the only one', () => {
    expect(accountLine(held('a', unnamed, mine, ready), facts)).toBe('Connected')
  })

  it('is called what Vivid calls it when it is one of several with nothing to tell it apart', () => {
    expect(accountLine(held('a', unnamed, mine, ready), { ...facts, alone: false })).toBe(
      'Linear (2)',
    )
  })

  it('says how it stands as well while it does not work', () => {
    expect(accountLine(account('a', unfinished), facts)).toBe('Work · Sign-in not finished')
    const revoked = ConnectionState.cases.Failed.make({ reason: 'the key was revoked' })
    expect(accountLine(held('a', unnamed, mine, revoked), facts)).toBe(
      'Not working: the key was revoked',
    )
  })

  it('says in words whom a Company’s account is shared with', () => {
    expect(accountLine(account('a', ready), { ...facts, sharedWith: Option.some('Acme') })).toBe(
      'Work · Shared with Acme',
    )
  })

  it('says where a press stands instead, while one is in flight', () => {
    expect(
      accountLine(account('a', unfinished), { ...facts, pressed: Option.some('waiting') }),
    ).toBe('Finish signing in, then come back')
  })

  it('is found by any part of its service’s name, whatever the case, and by an empty search', () => {
    expect(named('Google Calendar', '  calen ')).toBe(true)
    expect(named('Google Calendar', '')).toBe(true)
    expect(named('Google Calendar', 'mail')).toBe(false)
  })
})

describe('a pressed row', () => {
  it('keeps what it has to say, and is forgotten when it has nothing more to say', () => {
    const none: Presses = new Map()
    const pressed = afterPress(none, ServiceId.make('linear'), Option.some('starting'))
    expect([...pressed]).toEqual([['linear', 'starting']])
    // The earlier map is not changed: it is what React still holds for the render before.
    expect(none.size).toBe(0)
    expect(afterPress(pressed, ServiceId.make('linear'), Option.none()).size).toBe(0)
  })
})

describe('a service’s row in the catalog', () => {
  const key = ServiceAuthorization.cases.Key.make({ fields: [{ name: 'k', label: 'Key' }] })

  it('says how the service is entered only when that is worth knowing before pressing', () => {
    expect(
      noteOf(offered('Gmail', ServiceAuthorization.cases.SignIn.make({})), false, Option.none()),
    ).toEqual(Option.none())
    expect(noteOf(offered('Linear', key), false, Option.none())).toEqual(Option.some('Needs a key'))
    expect(
      noteOf(
        offered('Slack', ServiceAuthorization.cases.SetupRequired.make({})),
        false,
        Option.none(),
      ),
    ).toEqual(Option.some('Not set up on this Vivid'))
  })

  it('says a press before anything else, so adding one more account answers the press too', () => {
    expect(noteOf(offered('Linear', key), false, Option.some('refused'))).toEqual(
      Option.some('Did not start. Try again'),
    )
    expect(noteOf(offered('Linear', key), true, Option.some('starting'))).toEqual(
      Option.some('Connecting…'),
    )
  })

  it('says a connected service can be pressed for one more account', () => {
    expect(noteOf(offered('Linear', key), true, Option.none())).toEqual(
      Option.some('Connected · Add another account'),
    )
  })

  it('does not offer one more account where a sign-in can no longer be begun', () => {
    expect(
      noteOf(
        offered('Slack', ServiceAuthorization.cases.SetupRequired.make({})),
        true,
        Option.none(),
      ),
    ).toEqual(Option.some('Connected'))
  })

  it('lends its icon to a connected account only when it has one', () => {
    const drawn = offered('Gmail', key, 'https://icons.example/?domain=gmail.com')
    expect([...marksOf([drawn, offered('Linear', key)])]).toEqual([
      ['gmail', 'https://icons.example/?domain=gmail.com'],
    ])
  })

  it('is shelved by what it is for, in the sheet’s order, and under More when Vivid cannot place it', () => {
    const none = ServiceAuthorization.cases.None.make({})
    const groups = byPurpose([
      offered('Zzyzx', none),
      offered('GitHub', none),
      offered('Gmail', none),
      offered('Google Calendar', none),
    ])
    expect(
      groups.map((group) => [group.purpose, group.services.map((service) => service.name)]),
    ).toEqual([
      ['Mail and calendar', ['Gmail', 'Google Calendar']],
      ['Code and data', ['GitHub']],
      ['More', ['Zzyzx']],
    ])
  })
})

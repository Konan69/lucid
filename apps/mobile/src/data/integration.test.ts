import {
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  PersonId,
  ServiceAuthorization,
  ServiceId,
  type Connection,
  type Service,
} from '@vivid/contracts'
import { connecting } from '@vivid/state'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { byPurpose } from '../screen/integration/purpose.ts'
import {
  accountLine,
  cardSaid,
  marksOf,
  named,
  noteOf,
  pressedWords,
  refusalSentence,
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

/** A row or card with no attempt of its own under way. */
const still = connecting.Standing.cases.Still.make({})
const notBegun = connecting.Refusal.cases.NotBegun.make({})
const unopened = connecting.Refusal.cases.Unopened.make({ serviceName: 'Linear' })
const unshown = connecting.Refusal.cases.Unshown.make({ serviceName: 'Linear' })
/** A card on Linear whose first wait is said as "Connecting…". */
const card = { starting: 'Connecting…', serviceName: 'Linear' }
const unusable = connecting.Refusal.cases.Unusable.make({ serviceName: 'Linear' })
const refused = (refusal: connecting.Refusal) => connecting.Standing.cases.Refused.make({ refusal })

const unnamed: Said = { name: null, identity: null, account: 'Linear (2)' }

/** A row with nothing pressed, for the only account on its service unless said otherwise. */
const facts = { alone: true, sharedWith: Option.none<string>(), pressed: still }

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
      accountLine(account('a', unfinished), {
        ...facts,
        pressed: connecting.Standing.cases.Away.make({}),
      }),
    ).toBe('Finish signing in, then come back')
  })

  it('is found by any part of its service’s name, whatever the case, and by an empty search', () => {
    expect(named('Google Calendar', '  calen ')).toBe(true)
    expect(named('Google Calendar', '')).toBe(true)
    expect(named('Google Calendar', 'mail')).toBe(false)
  })
})

describe('a pressed row', () => {
  it('says nothing while a key is asked for: the form in front is the answer', () => {
    expect(pressedWords(still)).toEqual(Option.none())
    expect(
      pressedWords(
        connecting.Standing.cases.Keying.make({
          attempt: connecting.AttemptId.make('attempt-1'),
          id: ConnectionId.make('a'),
          serviceName: 'Linear',
          fields: [{ name: 'k', label: 'Key' }],
        }),
      ),
    ).toEqual(Option.none())
  })

  it('says it did not start however the attempt was refused', () => {
    expect(pressedWords(refused(notBegun))).toEqual(Option.some('Did not start. Try again'))
    expect(pressedWords(refused(unopened))).toEqual(Option.some('Did not start. Try again'))
    expect(pressedWords(refused(unshown))).toEqual(Option.some('Did not start. Try again'))
  })

  it('says the service did not accept a key, and promises no retry', () => {
    expect(pressedWords(refused(unusable))).toEqual(Option.some('Linear did not accept that.'))
  })

  it('says nothing of its own after a sign-in that was not finished: the list says that', () => {
    expect(pressedWords(connecting.Standing.cases.Unfinished.make({}))).toEqual(Option.none())
  })
})

describe('the sentence at the top of the page', () => {
  it('names the service whose sign-in page could not be opened', () => {
    expect(refusalSentence(unopened)).toEqual(
      Option.some('Linear’s sign-in page could not be opened.'),
    )
  })

  it('says nothing for a server that would not begin: the row that was pressed says that', () => {
    expect(refusalSentence(notBegun)).toEqual(Option.none())
  })

  it('says nothing for a key form that could not be brought up, as for one that did not begin', () => {
    expect(refusalSentence(unshown)).toEqual(Option.none())
  })
})

describe('what a card in a Thread says about its own attempt', () => {
  it('waits on its button in the card’s own word, and on the way back says it is checking', () => {
    const opening = { ...card, starting: 'Opening…' }
    expect(cardSaid(connecting.Standing.cases.Starting.make({}), opening)).toEqual({
      button: Option.some('Opening…'),
      line: Option.none(),
      carryOn: Option.none(),
    })
    expect(cardSaid(connecting.Standing.cases.Checking.make({}), opening)).toEqual({
      button: Option.some('Checking…'),
      line: Option.none(),
      carryOn: Option.none(),
    })
  })

  it('says quietly, while the Person is away, that Vivid goes on without being told', () => {
    expect(cardSaid(connecting.Standing.cases.Away.make({}), card).line).toEqual(
      Option.some({
        words: 'Finish signing in, then come back. Vivid carries on by itself.',
        urgent: false,
      }),
    )
  })

  it('says what did not happen as a refusal: the page by name, else that it did not start', () => {
    expect(cardSaid(refused(unopened), card).line).toEqual(
      Option.some({ words: 'Linear’s sign-in page could not be opened.', urgent: true }),
    )
    expect(cardSaid(refused(notBegun), card).line).toEqual(
      Option.some({ words: 'That did not start. Try again.', urgent: true }),
    )
    expect(cardSaid(refused(unshown), card).line).toEqual(
      Option.some({ words: 'That did not start. Try again.', urgent: true }),
    )
  })

  it('carries the Thread on, and does not offer its own way in, for a key the service refused', () => {
    expect(cardSaid(refused(unusable), card)).toEqual({
      button: Option.some('Carry on'),
      line: Option.some({ words: 'Linear did not accept that.', urgent: true }),
      // The button tells Vivid what happened; it does not pick the refused account up again.
      carryOn: Option.some('Linear did not accept that key.'),
    })
    // Every other ending leaves the button as the attempt, to be made again.
    expect(cardSaid(refused(notBegun), card).carryOn).toEqual(Option.none())
    expect(cardSaid(connecting.Standing.cases.Unfinished.make({}), card).carryOn).toEqual(
      Option.none(),
    )
    // The top of the Integrations page adds nothing: the row that asked for the key says it.
    expect(refusalSentence(unusable)).toEqual(Option.none())
  })

  it('says calmly that a sign-in was left unfinished, and offers to try again', () => {
    expect(cardSaid(connecting.Standing.cases.Unfinished.make({}), card)).toEqual({
      button: Option.some('Try again'),
      line: Option.some({ words: 'Linear is not signed in yet.', urgent: false }),
      carryOn: Option.none(),
    })
  })

  it('offers its own way in again once nothing is under way', () => {
    expect(cardSaid(still, card)).toEqual({
      button: Option.none(),
      line: Option.none(),
      carryOn: Option.none(),
    })
  })
})

describe('a service’s row in the catalog', () => {
  const key = ServiceAuthorization.cases.Key.make({ fields: [{ name: 'k', label: 'Key' }] })

  it('says how the service is entered only when that is worth knowing before pressing', () => {
    expect(
      noteOf(offered('Gmail', ServiceAuthorization.cases.SignIn.make({})), false, still),
    ).toEqual(Option.none())
    expect(noteOf(offered('Linear', key), false, still)).toEqual(Option.some('Needs a key'))
    expect(
      noteOf(offered('Slack', ServiceAuthorization.cases.SetupRequired.make({})), false, still),
    ).toEqual(Option.some('Not set up on this Vivid'))
  })

  it('says a press before anything else, so adding one more account answers the press too', () => {
    expect(noteOf(offered('Linear', key), false, refused(notBegun))).toEqual(
      Option.some('Did not start. Try again'),
    )
    expect(
      noteOf(offered('Linear', key), true, connecting.Standing.cases.Starting.make({})),
    ).toEqual(Option.some('Connecting…'))
  })

  it('says a connected service can be pressed for one more account', () => {
    expect(noteOf(offered('Linear', key), true, still)).toEqual(
      Option.some('Connected · Add another account'),
    )
  })

  it('does not offer one more account where a sign-in can no longer be begun', () => {
    expect(
      noteOf(offered('Slack', ServiceAuthorization.cases.SetupRequired.make({})), true, still),
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

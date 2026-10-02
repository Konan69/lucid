import {
  ConnectionAuthorization,
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  PersonId,
  ServiceId,
  type Connection,
  type ConnectionRequestMessage,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { Finish, finishOf, finishOfStep, isReady } from './integration.ts'

const ada = { id: PersonId.make('ada'), name: 'Ada Obi', image: null }

const account = (id: string, state: ConnectionState): Connection => ({
  id: ConnectionId.make(id),
  service: ServiceId.make('linear'),
  serviceName: 'Linear',
  label: 'Work',
  ownership: ConnectionOwnership.cases.Personal.make({ owner: ada }),
  state,
  createdAt: 1,
})

const request: ConnectionRequestMessage = {
  kind: 'connection-request',
  service: ServiceId.make('linear'),
  serviceName: 'Linear',
  reason: 'To read the issue',
  ready: false,
}

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

describe('whether the Integration a card stands for is ready', () => {
  const other = account('other', ConnectionState.cases.Ready.make({}))

  it('takes any ready account on the service when Vivid only offered the service', () => {
    expect(isReady([other], request, Option.none())).toBe(true)
    expect(
      isReady(
        [account('other', ConnectionState.cases.NeedsAuthorization.make({}))],
        request,
        Option.none(),
      ),
    ).toBe(false)
  })

  it('takes only the account Vivid started, not another on the same service', () => {
    expect(isReady([other], request, Option.some(started))).toBe(false)
    expect(
      isReady(
        [other, account('started', ConnectionState.cases.Ready.make({}))],
        request,
        Option.some(started),
      ),
    ).toBe(true)
  })
})

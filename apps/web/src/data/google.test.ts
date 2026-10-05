import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { firstArrival, googleAddresses, outcomeOf, readAddress, Standing } from './google'

describe('what a Better Auth code means to a Person', () => {
  it('reads closing Google’s screen as a choice, not a fault', () => {
    expect(outcomeOf('access_denied')).toBe('Cancelled')
  })

  it('reads an email that already has a password account as one to sign in to', () => {
    expect(outcomeOf('account_not_linked')).toBe('NotLinked')
  })

  it('reads every code it has no sentence for as a failure to try again', () => {
    expect(outcomeOf('state_mismatch')).toBe('Failed')
    expect(outcomeOf('invalid_code')).toBe('Failed')
  })
})

describe('reading the address the welcome was opened at', () => {
  it('starts Google for the address a phone opens, and goes on to approve that phone', () => {
    expect(readAddress('/device?user_code=ABCD2345&signin=google')).toEqual({
      destination: '/device?user_code=ABCD2345',
      standing: Standing.Start(),
    })
  })

  it('says why a Google sign-in came back, and drops the error from where to go next', () => {
    expect(
      readAddress(
        '/invite/abc?signin=returned&error=account_not_linked&error_description=Not%20linked',
      ),
    ).toEqual({
      destination: '/invite/abc',
      standing: Standing.Returned({ outcome: 'NotLinked' }),
    })
  })

  it('does not take an error it was not sent back with as a Google failure', () => {
    expect(readAddress('/?error=access_denied').standing).toEqual(Standing.Plain())
  })

  it('does not start for a mark it never writes', () => {
    expect(readAddress('/?signin=github').standing).toEqual(Standing.Plain())
  })

  it('goes to the first screen when the address names another site', () => {
    expect(readAddress('//elsewhere.example/device?signin=google')).toEqual({
      destination: '/',
      standing: Standing.Plain(),
    })
  })
})

describe('the addresses Better Auth is given for one Google sign-in', () => {
  const given = googleAddresses('/device?user_code=ABCD2345')

  it('lands a returning Person where they were going', () => {
    expect(given.callbackURL).toBe('/device?user_code=ABCD2345')
  })

  it('lands a failure back on a welcome that says why and does not start again', () => {
    // Better Auth appends its code to the address it was given (`appendQueryParams`).
    const landed = readAddress(`${given.errorCallbackURL}&error=access_denied`)
    expect(landed).toEqual({
      destination: '/device?user_code=ABCD2345',
      standing: Standing.Returned({ outcome: 'Cancelled' }),
    })
  })

  it('lands a new account where its time zone is adopted, then on the same place', () => {
    expect(firstArrival(given.newUserCallbackURL)).toEqual(
      Option.some('/device?user_code=ABCD2345'),
    )
  })

  it('never hands Better Auth an address that restarts Google', () => {
    const restarting = googleAddresses('/?signin=google')
    for (const address of Object.values(restarting)) {
      expect(readAddress(address).standing).not.toEqual(Standing.Start())
    }
  })
})

describe('the landing of a first sign-in with Google', () => {
  it('is not any other landing', () => {
    expect(firstArrival('/device?user_code=ABCD2345')).toEqual(Option.none())
    expect(firstArrival('/?joined=email')).toEqual(Option.none())
  })
})

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

  it('reads a server with no Google client the same before leaving and on the way back', () => {
    expect(outcomeOf('PROVIDER_NOT_FOUND')).toBe('NotSetUp')
    expect(outcomeOf('oauth_provider_not_found')).toBe('NotSetUp')
  })

  it('reads every code it has no sentence for as a failure to try again', () => {
    expect(outcomeOf('state_mismatch')).toBe('Failed')
    expect(outcomeOf('invalid_code')).toBe('Failed')
  })
})

describe('reading the address the welcome was opened at', () => {
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

  it('reads a mark it never writes as no mark, and still takes it off', () => {
    expect(readAddress('/library?signin=google')).toEqual({
      destination: '/library',
      standing: Standing.Plain(),
    })
  })

  it('goes to the first screen when the address names another site', () => {
    expect(
      readAddress('//elsewhere.example/invite/abc?signin=returned&error=access_denied'),
    ).toEqual({
      destination: '/',
      standing: Standing.Plain(),
    })
  })
})

describe('the addresses Better Auth is given for one Google sign-in', () => {
  const given = googleAddresses('/invite/abc?from=mail')

  it('lands a returning Person where they were going', () => {
    expect(given.callbackURL).toBe('/invite/abc?from=mail')
  })

  it('lands a failure back on a welcome that says why', () => {
    // Better Auth appends its code to the address it was given (`appendQueryParams`).
    const landed = readAddress(`${given.errorCallbackURL}&error=access_denied`)
    expect(landed).toEqual({
      destination: '/invite/abc?from=mail',
      standing: Standing.Returned({ outcome: 'Cancelled' }),
    })
  })

  it('lands a new account where its time zone is adopted, then on the same place', () => {
    expect(firstArrival(given.newUserCallbackURL)).toEqual(Option.some('/invite/abc?from=mail'))
  })

  it('never hands Better Auth an address that carries an earlier attempt’s error', () => {
    const after = googleAddresses('/library?signin=returned&error=access_denied')
    expect(after.callbackURL).toBe('/library')
    expect(readAddress(after.newUserCallbackURL).standing).toEqual(Standing.Plain())
    expect(readAddress(after.errorCallbackURL).standing).toEqual(Standing.Plain())
  })
})

describe('the landing of a first sign-in with Google', () => {
  it('is not any other landing', () => {
    expect(firstArrival('/invite/abc?from=mail')).toEqual(Option.none())
    expect(firstArrival('/?joined=email')).toEqual(Option.none())
  })
})

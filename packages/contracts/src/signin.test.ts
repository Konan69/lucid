import { describe, expect, it } from '@effect/vitest'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  LoopbackPort,
  readSignInReturn,
  SignInAttempt,
  SignInChallenge,
  SignInCode,
  SignInReturn,
  signInReturnAddress,
  SignInStart,
  signInStartAddress,
} from './signin.js'

/**
 * The two addresses of the desktop app's Google sign-in are written by one party and read by
 * another: the shell writes the start and the server reads it, the server writes the return and
 * the shell reads it. These tests hold the two ends of each to one meaning.
 */
const state = SignInAttempt.make('Ab3dEf6hIj9kLm2n')
const challenge = SignInChallenge.make('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
const code = SignInCode.make('a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6')
const port = LoopbackPort.make(49_321)
const decodeStart = Schema.decodeUnknownOption(SignInStart)

/** What the shell's listener is handed for an address the server sent a browser to. */
const arrivingAt = (address: string) => readSignInReturn(new URL(address).searchParams)

describe('the desktop sign-in addresses', () => {
  it('starts on the server the shell saved, with exactly what the server reads back', () => {
    const address = new URL(signInStartAddress('https://vivid.example', { challenge, state, port }))
    expect(address.origin).toBe('https://vivid.example')
    expect(address.pathname).toBe('/api/auth/desktop/google')
    expect(decodeStart(Object.fromEntries(address.searchParams))).toEqual(
      Option.some({ challenge, state, port }),
    )
  })

  it('returns a code to the loopback address and to no name that could resolve elsewhere', () => {
    const granted = SignInReturn.cases.Granted.make({ code, state })
    const address = signInReturnAddress(port, granted)
    expect(new URL(address).origin).toBe('http://127.0.0.1:49321')
    expect(arrivingAt(address)).toEqual(Option.some(granted))
  })

  it('returns a failure without a code', () => {
    const failed = SignInReturn.cases.Failed.make({ state })
    const address = signInReturnAddress(port, failed)
    expect(new URL(address).searchParams.has('code')).toBe(false)
    expect(arrivingAt(address)).toEqual(Option.some(failed))
  })

  it('reads nothing from a request that is not a return', () => {
    expect(arrivingAt('http://127.0.0.1:49321/favicon.ico')).toEqual(Option.none())
    expect(arrivingAt(`http://127.0.0.1:49321/?code=${code}&state=short`)).toEqual(Option.none())
    expect(arrivingAt(`http://127.0.0.1:49321/?code=not-a-code&state=${state}`)).toEqual(
      Option.none(),
    )
  })
})

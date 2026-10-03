import { expect, it } from 'vitest'
import { AccountRefused, AccountUnreachable, saidFor } from './refusal.ts'

it('says a wrong password beside the password field', () => {
  const said = saidFor(new AccountRefused({ reason: 'WrongCredentials', message: 'x' }))
  expect(said).toEqual({ beside: 'password', words: 'That password is not right.' })
})

it('never shows the server its own wording for an unknown refusal', () => {
  const said = saidFor(new AccountRefused({ reason: 'Other', message: 'INVALID_ORIGIN at /api' }))
  expect(said.words).toBe('That did not work. Try again.')
})

it('says a lost connection in plain words, with no address in it', () => {
  const said = saidFor(new AccountUnreachable({ message: 'http://10.0.0.2:5178 refused' }))
  expect(said).toEqual({
    beside: 'form',
    words: 'Can’t reach Vivid. Check your connection and try again.',
  })
})

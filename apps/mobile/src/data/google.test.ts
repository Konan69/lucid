import { Result } from 'effect'
import { expect, it } from 'vitest'
import { googleAddress } from './google.ts'
import { parseServer } from './server.ts'

const server = Result.getOrThrow(parseServer('https://vivid.example.com'))

it('opens the approval page for this phone’s code and asks the web to start Google', () => {
  const opened = new URL(googleAddress(server, 'ABCD2345'))
  expect(opened.origin).toBe('https://vivid.example.com')
  expect(opened.pathname).toBe('/device')
  expect(Object.fromEntries(opened.searchParams)).toEqual({
    user_code: 'ABCD2345',
    signin: 'google',
  })
})

it('keeps a code with characters an address would otherwise read as its own', () => {
  const opened = new URL(googleAddress(server, 'AB&signin=x'))
  expect(opened.searchParams.get('user_code')).toBe('AB&signin=x')
  expect(opened.searchParams.getAll('signin')).toEqual(['google'])
})

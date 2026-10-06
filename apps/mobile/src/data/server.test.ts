import { ThreadId } from '@vivid/contracts'
import { Result } from 'effect'
import { expect, it } from 'vitest'
import {
  accountAddress,
  connectionsAddress,
  libraryAddress,
  liveAddress,
  parseServer,
  recordAddress,
  rulesAddress,
  serverName,
  threadAddress,
} from './server.ts'

/** A server the tests build addresses from, read the way the sign-in screen reads one. */
const server = (text: string) => Result.getOrThrow(parseServer(text))

it('accepts a web address and drops what trails it', () => {
  expect(server(' https://vivid.example.com/ ')).toBe('https://vivid.example.com')
  expect(server('http://192.168.1.20:5178')).toBe('http://192.168.1.20:5178')
})

it('refuses an address that could carry a credential or is not a web server', () => {
  for (const text of [
    'not an address',
    'file:///tmp/vivid',
    'javascript:alert(1)',
    'https://someone:secret@vivid.example.com',
    'https://vivid.example.com?token=secret',
    'https://vivid.example.com#token',
  ]) {
    expect(Result.isFailure(parseServer(text))).toBe(true)
  }
})

it('builds every address the app calls from the one server', () => {
  const local = server('http://192.168.1.20:5178')
  expect(serverName(local)).toBe('192.168.1.20:5178')
  expect(accountAddress(local, 'sign-in/email')).toBe(
    'http://192.168.1.20:5178/api/auth/sign-in/email',
  )
  expect(liveAddress(local)).toBe('ws://192.168.1.20:5178/api/live')
  expect(liveAddress(server('https://vivid.example.com'))).toBe('wss://vivid.example.com/api/live')
  expect(libraryAddress(local, '/abc/content')).toBe(
    'http://192.168.1.20:5178/api/library/abc/content',
  )
})

it('reaches a conversation only through the gateway', () => {
  expect(threadAddress(server('https://vivid.example.com'), ThreadId.make('a/b'))).toBe(
    'https://vivid.example.com/api/vivid/a%2Fb',
  )
})

it('opens the web app on the Settings section a row names', () => {
  // The web router reads the section from `?settings=`; a name it does not know opens nothing.
  const local = server('http://192.168.1.20:5178')
  expect(connectionsAddress(local)).toBe('http://192.168.1.20:5178/?settings=connections')
  expect(rulesAddress(local)).toBe('http://192.168.1.20:5178/?settings=rules')
  expect(recordAddress(local)).toBe('http://192.168.1.20:5178/?settings=record')
})

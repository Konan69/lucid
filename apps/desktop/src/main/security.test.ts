import { describe, expect, it } from '@effect/vitest'
import { ServerAddress, ServerSettings } from '../shared/settings.ts'
import {
  isAllowedPermission,
  isAllowedRedirect,
  isAllowedResponse,
  isAppRequest,
  isTrustedDocument,
} from './security.ts'

const server = ServerSettings.cases.Server.make({
  origin: ServerAddress.make('https://vivid.example'),
})
const absent = ServerSettings.cases.NoServer.make({})
const chooser = 'file:///application/chooser.html'

describe('desktop origin policy', () => {
  it('admits only the saved authority, including matching WebSockets', () => {
    for (const url of ['https://vivid.example/api/rpc', 'wss://vivid.example/api/live']) {
      expect(isAppRequest(url, server)).toBe(true)
      expect(isAppRequest(url, absent)).toBe(false)
    }
    for (const url of [
      'https://other.example/api/rpc',
      'https://vivid.example.evil.test',
      'https://vivid.example:8443/api/rpc',
      'http://vivid.example',
      'ws://vivid.example/api/live',
      'https://person:secret@vivid.example',
      'file:///application/chooser.html',
      'malformed',
    ]) {
      expect(isAppRequest(url, server)).toBe(false)
    }
  })

  it('refuses foreign redirects and preserves same-origin relative redirects', () => {
    expect(isAllowedRedirect('https://vivid.example/api/start', '/api/end', server)).toBe(true)
    for (const url of [
      '//other.example/end',
      'https://other.example',
      'http://vivid.example',
      'file:///secret',
    ]) {
      expect(isAllowedRedirect('https://vivid.example/api/start', url, server)).toBe(false)
    }
    expect(isAllowedRedirect('https://other.example', '/end', server)).toBe(false)
    expect(
      isAllowedResponse({
        url: 'https://vivid.example/api/start',
        status: 307,
        headers: { Location: ['https://other.example/end'] },
        server,
      }),
    ).toBe(false)
    expect(
      isAllowedResponse({
        url: 'https://vivid.example/api/start',
        status: 302,
        headers: { location: ['/api/end'] },
        server,
      }),
    ).toBe(true)
    expect(
      isAllowedResponse({
        url: 'https://vivid.example/api/start',
        status: 302,
        headers: { location: ['/api/end', '//other.example'] },
        server,
      }),
    ).toBe(false)
  })

  it('allows only the precise local chooser before selection and the app document afterward', () => {
    expect(isTrustedDocument(`${chooser}#server`, absent, chooser)).toBe(true)
    expect(isTrustedDocument('file:///application/other.html', absent, chooser)).toBe(false)
    expect(isTrustedDocument('https://vivid.example', absent, chooser)).toBe(false)
    expect(isTrustedDocument(chooser, server, chooser)).toBe(false)
    expect(isTrustedDocument('https://vivid.example/thread/123', server, chooser)).toBe(true)
    expect(isTrustedDocument('wss://vivid.example/api/live', server, chooser)).toBe(false)
  })

  it('grants notifications and clipboard writes only to the chosen app origin', () => {
    for (const permission of ['notifications', 'clipboard-sanitized-write']) {
      expect(isAllowedPermission(permission, 'https://vivid.example/thread/123', server)).toBe(true)
      expect(isAllowedPermission(permission, 'https://other.example', server)).toBe(false)
      expect(isAllowedPermission(permission, chooser, absent)).toBe(false)
    }
    for (const permission of [
      'media',
      'clipboard-read',
      'geolocation',
      'display-capture',
      'usb',
      'unknown',
    ]) {
      expect(isAllowedPermission(permission, 'https://vivid.example', server)).toBe(false)
    }
  })
})

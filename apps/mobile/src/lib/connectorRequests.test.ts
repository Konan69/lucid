import { expect, it } from 'vitest'
import {
  authorizationAddress,
  readConnectorRequest,
} from '../../../web/src/data/connectorRequests.ts'

it('connector cards accept only supported IDs and bounded, nonempty reasons', () => {
  expect(
    readConnectorRequest({
      kind: 'connector-request',
      connector: 'gmail',
      reason: ' Find the reply. ',
    }),
  ).toStrictEqual({
    kind: 'connector-request',
    connector: 'gmail',
    reason: 'Find the reply.',
  })
  for (const connector of ['__proto__', 'constructor', '../../auth', 'slack']) {
    expect(
      readConnectorRequest({
        kind: 'connector-request',
        connector,
        reason: 'Connect',
      }),
    ).toBeNull()
  }
  for (const reason of [null, ' ', 'a'.repeat(401)]) {
    expect(
      readConnectorRequest({
        kind: 'connector-request',
        connector: 'drive',
        reason,
      }),
    ).toBeNull()
  }
  expect(readConnectorRequest({ connector: 'gmail', reason: 'Connect' })).toBeNull()
})

it('authorization handoffs reject executable URLs and embedded credentials', () => {
  expect(authorizationAddress('https://accounts.google.com/o/oauth2/v2/auth?state=test')).toBe(
    'https://accounts.google.com/o/oauth2/v2/auth?state=test',
  )
  for (const address of [
    undefined,
    'javascript:alert(1)',
    'file:///tmp/auth',
    'http://accounts.google.com',
    'https://user:password@example.com',
    '/auth',
  ]) {
    expect(() => authorizationAddress(address)).toThrow()
  }
})

import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { ServerAddress, ServerSettings } from '../shared/settings.ts'
import { clearingLeft, storageLeftBehind, type StorageToClear } from './leaving.ts'

const none = ServerSettings.cases.NoServer.make({})
const server = (origin: string) =>
  ServerSettings.cases.Server.make({ origin: ServerAddress.make(origin) })

describe('leaving a server', () => {
  const kinds = ['indexdb', 'localstorage', 'serviceworkers', 'cachestorage']

  it('clears what the app kept for the server that was forgotten', () => {
    expect(storageLeftBehind(server('https://one.example.com'), none)).toEqual(
      Option.some({ origin: 'https://one.example.com', storages: kinds }),
    )
  })

  it('clears the old server when a different one is chosen, and never the new one', () => {
    expect(
      storageLeftBehind(server('https://one.example.com'), server('https://two.example.com')),
    ).toEqual(Option.some({ origin: 'https://one.example.com', storages: kinds }))
  })

  it('clears nothing when there was no server, or the same one is chosen again', () => {
    expect(storageLeftBehind(none, server('https://one.example.com'))).toEqual(Option.none())
    expect(
      storageLeftBehind(server('https://one.example.com'), server('https://one.example.com')),
    ).toEqual(Option.none())
  })

  it.effect('asks Electron to clear exactly that, and goes on when it cannot', () =>
    Effect.gen(function* () {
      const asked: Array<StorageToClear> = []
      const left = storageLeftBehind(server('https://one.example.com'), none)
      yield* clearingLeft(left, {
        clearStorageData: (storage) => {
          asked.push(storage)
          return Promise.resolve()
        },
      })
      expect(asked).toEqual([{ origin: 'https://one.example.com', storages: kinds }])
      // Cookies are never among the kinds: Electron clears those for the whole domain.
      expect(asked.flatMap((storage) => storage.storages)).not.toContain('cookies')
      yield* clearingLeft(left, { clearStorageData: () => Promise.reject(new Error('disk')) })
      yield* clearingLeft(Option.none(), {
        clearStorageData: () => Promise.reject(new Error('never asked')),
      })
    }),
  )
})

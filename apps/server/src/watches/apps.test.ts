import { describe, expect, layer } from '@effect/vitest'
import { Company, CompanyId, ConnectionId, ServiceId, Workspace } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Option, Redacted, Ref } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import type { Actor } from '../auth/access.ts'
import {
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorBinding,
  ExecutorOwnerId,
  ExecutorReferences,
} from '../connections/executor.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { claimedApp, encodeReferences } from '../connections/records.ts'
import { connections } from '../connections/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { makeWatchedApps } from './apps.ts'
import { person } from './testing.ts'

/**
 * Whose app a Watch resolves, over the real Connection store on the disposable database. Executor
 * stands in only for its app record, which answers each app id with a slug of its own and records
 * which ids were asked for.
 */

const settings = {
  url: 'http://executor.test',
  key: Redacted.make('test-key'),
  organization: 'org_test',
}

/** Executor's `GET /apps/<id>`: the slug is the id's last part, so each app is told apart. */
const executor = (asked: Ref.Ref<ReadonlyArray<string>>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const app = decodeURIComponent(request.url.slice(request.url.lastIndexOf('/') + 1))
      yield* Ref.update(asked, (previous) => [...previous, app])
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ slug: `slug-${app}` }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )

/** Store one of the Actor's own Connections with these references, as the Connection store does. */
const connect = Effect.fn('WatchAppsTest.connect')(function* (
  actor: Actor,
  serviceName: string,
  references: ExecutorReferences,
  status: 'ready' | 'failed',
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const id = ConnectionId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(connections).values({
      id,
      service: references.service,
      serviceName,
      name: null,
      identity: null,
      label: serviceName,
      personId: actor.person.id,
      companyId: null,
      references: yield* encodeReferences(references),
      executorApp: claimedApp(references),
      status,
      returnsTo: 'Web',
      reason: status === 'ready' ? null : 'Connect it again.',
      createdAt: now,
      updatedAt: now,
    }),
  )
  return id
})

/**
 * A Company with these two People as Members, each as an Actor working in it. The Company is removed
 * when the test ends; the cleanup is registered before the first write.
 */
const company = Effect.fn('WatchAppsTest.company')(function* (first: Actor, second: Actor) {
  const database = yield* Database
  const made = Company.make({
    id: CompanyId.make(crypto.randomUUID()),
    name: 'Watch Company',
    slug: crypto.randomUUID(),
  })
  yield* Effect.addFinalizer(() =>
    database
      .run(database.delete(companyTable).where(eq(companyTable.id, made.id)))
      .pipe(Effect.catch(() => Effect.sync(() => expect.fail('Company cleanup failed')))),
  )
  yield* database.run(database.insert(companyTable).values(made))
  yield* database.run(
    database.insert(membershipTable).values(
      [first, second].map((member) => ({
        id: crypto.randomUUID(),
        companyId: made.id,
        userId: member.person.id,
        role: 'member',
      })),
    ),
  )
  const workspace = Workspace.cases.Company.make({ company: made, role: 'member' })
  return { id: made.id, first: { ...first, workspace }, second: { ...second, workspace } }
})

/** A ready account on an app of its own, as every Connection since Executor beta.23 has. */
const authorized = (app: string) =>
  ExecutorReferences.cases.Authorized.make({
    service: ServiceId.make('mail'),
    app: ExecutorAppId.make(app),
    owner: ExecutorOwnerId.make('owner_test'),
    binding: ExecutorBinding.cases.Account.make({ requirement: 'mail', scope: 'user' }),
    account: ExecutorAccountId.make(`account-${app}`),
  })

/** A selection from before beta.23 whose app other accounts may share. It claims no app. */
const shared = ExecutorReferences.cases.ReconnectRequired.make({
  service: ServiceId.make('calendar'),
  owner: ExecutorOwnerId.make('owner_test'),
  retired: {
    original: ExecutorAppId.make('app-shared'),
    ownership: 'Unproven',
    account: Option.some(ExecutorAccountId.make('account-shared')),
    copies: [],
    authorization: Option.none(),
  },
  reason: 'SharedSelection',
})

describe.skipIf(!testDatabaseConfigured)('Watched apps', () => {
  layer(testDatabaseLayer)((it) => {
    it.effect('resolves each Person’s account to their own app and refuses a shared one', () =>
      Effect.gen(function* () {
        const ada = yield* person()
        const ben = yield* person()
        const appA = `app-${crypto.randomUUID()}`
        const appB = `app-${crypto.randomUUID()}`
        // Both Persons call their account "Mail": only the app behind each name differs.
        yield* connect(ada, 'Mail', authorized(appA), 'ready')
        yield* connect(ben, 'Mail', authorized(appB), 'ready')
        yield* connect(ada, 'Calendar', shared, 'failed')
        const asked = yield* Ref.make<ReadonlyArray<string>>([])
        const apps = makeWatchedApps(yield* Database, executor(asked), settings)

        expect(yield* apps.appOf(ada, 'mail')).toEqual({ account: 'Mail', appSlug: `slug-${appA}` })
        expect(yield* Ref.get(asked)).toEqual([appA])
        expect(yield* apps.appOf(ben, 'Mail')).toEqual({ account: 'Mail', appSlug: `slug-${appB}` })
        expect(yield* Ref.get(asked)).toEqual([appA, appB])

        const refused = yield* Effect.flip(apps.appOf(ada, 'Calendar'))
        expect(refused._tag).toBe('WatchAccountShared')
        // Ada's shared account is not Ben's to name, let alone watch.
        expect((yield* Effect.flip(apps.appOf(ben, 'Calendar')))._tag).toBe('WatchAccountUnknown')
        // Neither refusal asked Executor for any app.
        expect(yield* Ref.get(asked)).toEqual([appA, appB])
        expect(yield* apps.accountsOf(ada)).toEqual(['Mail'])
        expect(yield* apps.accountsOf(ben)).toEqual(['Mail'])
      }).pipe(Effect.scoped),
    )

    it.effect('a Company account another Member added is not this Person’s to watch', () =>
      Effect.gen(function* () {
        const shop = yield* company(yield* person(), yield* person())
        const { first: ada, second: ben } = shop
        const app = `app-${crypto.randomUUID()}`
        // Ben's dedicated, ready account, shared with the Company, so its inventory lists it.
        const id = yield* connect(ben, 'Mail', authorized(app), 'ready')
        const database = yield* Database
        yield* database.run(
          database.update(connections).set({ companyId: shop.id }).where(eq(connections.id, id)),
        )
        const asked = yield* Ref.make<ReadonlyArray<string>>([])
        const apps = makeWatchedApps(database, executor(asked), settings)

        expect(yield* apps.appOf(ben, 'Mail')).toEqual({ account: 'Mail', appSlug: `slug-${app}` })
        expect((yield* Effect.flip(apps.appOf(ada, 'Mail')))._tag).toBe('WatchAccountUnknown')
        expect(yield* apps.accountsOf(ada)).toEqual([])
        expect(yield* apps.accountsOf(ben)).toEqual(['Mail'])
        // Ada's refusal never asked Executor for Ben's app.
        expect(yield* Ref.get(asked)).toEqual([app])
      }).pipe(Effect.scoped),
    )
  })
})

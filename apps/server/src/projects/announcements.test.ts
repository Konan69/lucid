import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { NotFound, ProjectId, Workspace } from '@vivid/contracts'
import { inArray } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { fixture } from '../approvals/testing.ts'
import { companyColumnOf, requireAdmin, type Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, observing, payload, silent } from '../live/testing.ts'
import { ProjectStore, projectStoreLayer } from './store.ts'
import { projectTable } from './tables.ts'

const testLayer = Layer.merge(projectStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** Count only this fixture's Projects, so assertions do not depend on another case's rows. */
const stored = Effect.fn('ProjectAnnouncements.stored')(function* (test: Fixture) {
  const database = yield* Database
  return yield* database.run(
    database
      .select()
      .from(projectTable)
      .where(inArray(projectTable.createdBy, [test.personal.person.id, test.other.person.id])),
  )
})

/** Seed parents before opening LISTEN, keeping setup outside the ordered operation receipt. */
const seed = Effect.fn('ProjectAnnouncements.seed')(function* (actor: Actor) {
  const database = yield* Database
  const id = ProjectId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(projectTable).values({
      id,
      name: 'Parent',
      companyId: companyColumnOf(actor.workspace),
      createdBy: actor.person.id,
    }),
  )
  return id
})

/** Direct stores must commit the Project and announce its stored owner to the real live loader. */
describe.skipIf(!testDatabaseConfigured)('Project transaction announcements', () => {
  layer(testLayer)((it) => {
    it.effect('P1 personal create refreshes its owner', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ProjectStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing(
          [Topic.person(test.personal.person.id)],
          store.list(test.personal),
        )
        expect(observation.initial).toEqual([])
        const project = yield* store.create(test.personal, {
          name: 'Personal',
          parentProjectId: null,
        })
        yield* payload(notifications, [Topic.person(test.personal.person.id)])
        expect(yield* nextValue(observation)).toEqual([project])
        expect(project.companyId).toBeNull()
        expect(project.createdBy).toBe(test.personal.person.id)
      }).pipe(Effect.scoped),
    )
    it.effect('P2 Company create refreshes another Member with only the stored Company topic', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ProjectStore
        const { company } = yield* requireAdmin(test.owner.workspace)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing([Topic.company(company.id)], store.list(test.owner))
        expect(observation.initial).toEqual([])
        const project = yield* store.create(test.member, { name: 'Company', parentProjectId: null })
        yield* payload(notifications, [Topic.company(company.id)])
        expect(yield* nextValue(observation)).toEqual([project])
        expect(project.companyId).toBe(company.id)
        expect(project.createdBy).toBe(test.member.person.id)
      }).pipe(Effect.scoped),
    )
    for (const workspace of ['personal', 'member'] as const) {
      it.effect(`P3 ${workspace} child retains its parent's scope and announces once`, () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const actor = test[workspace]
          const parentId = yield* seed(actor)
          const store = yield* ProjectStore
          const topics = Workspace.match(actor.workspace, {
            Personal: () => [Topic.person(actor.person.id)],
            Company: ({ company }) => [Topic.company(company.id)],
          })
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          const observation = yield* observing(topics, store.list(actor))
          const child = yield* store.create(actor, { name: 'Child', parentProjectId: parentId })
          yield* payload(notifications, topics)
          expect((yield* nextValue(observation)).map((project) => project.id)).toContain(child.id)
          const rows = yield* stored(test)
          const parent = rows.find((row) => row.id === parentId)
          const storedChild = rows.find((row) => row.id === child.id)
          if (parent === undefined)
            return yield* Effect.sync(() => expect.fail('Parent fixture missing'))
          expect(storedChild).toMatchObject({
            parentProjectId: parentId,
            companyId: parent.companyId,
            createdBy: actor.person.id,
          })
          if (workspace === 'personal') expect(child.createdBy).toBe(parent.createdBy)
        }).pipe(Effect.scoped),
      )
    }
    it.effect('P4 foreign-workspace and missing parents write and announce nothing', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const otherParent = yield* seed(test.other)
        const personalParent = yield* seed(test.personal)
        const companyParent = yield* seed(test.member)
        const before = yield* stored(test)
        const store = yield* ProjectStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const cases = [
          { actor: test.personal, parentProjectId: otherParent },
          { actor: test.member, parentProjectId: personalParent },
          { actor: test.personal, parentProjectId: companyParent },
          { actor: test.personal, parentProjectId: ProjectId.make(crypto.randomUUID()) },
        ]
        for (const input of cases) {
          expect(
            yield* store
              .create(input.actor, { name: 'Refused', parentProjectId: input.parentProjectId })
              .pipe(Effect.flip),
          ).toEqual(new NotFound({ message: 'Parent Project not found' }))
          yield* silent(notifications)
          expect(yield* stored(test)).toEqual(before)
        }
      }).pipe(Effect.scoped),
    )
  })
})

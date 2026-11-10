import * as NodeFS from 'node:fs'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { Effect, Layer, Option, Result } from 'effect'
import {
  Company,
  CompanyId,
  Person,
  PersonId,
  SessionId,
  SkillScope,
  SkillOrigin,
  ThreadId,
  Workspace,
  type Role,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable } from '../companies/tables.ts'
import { skills as skillTable } from './tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { skillHandlers } from './handlers.ts'
import { SkillStore, skillStoreLayer } from './store.ts'
import { builtins } from './builtin/index.ts'

const testLayer = skillStoreLayer.pipe(
  Layer.provideMerge(testDatabaseLayer),
  Layer.provideMerge(silentChangesLayer),
)
const request = {
  name: 'Prepare a brief',
  about: 'Turns your notes into a brief you can review.',
  useWhen: 'Before your weekly review',
  instructions: 'Read your notes and draft a brief.',
  forCompany: false,
}

/** Every case owns fresh identities and registers cascading cleanup before the first write. */
const fixture = Effect.fn('SkillsTest.fixture')(function* () {
  const database = yield* Database
  const first = new Person({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Ada',
    email: `${NodeCrypto.randomUUID()}@example.test`,
  })
  const second = new Person({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Bayo',
    email: `${NodeCrypto.randomUUID()}@example.test`,
  })
  const company = new Company({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Studio',
    slug: NodeCrypto.randomUUID(),
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const cleaned = yield* Effect.result(
        Effect.gen(function* () {
          yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
          yield* database.run(
            database.delete(personTable).where(inArray(personTable.id, [first.id, second.id])),
          )
        }),
      )
      expect(Result.isSuccess(cleaned)).toBe(true)
    }),
  )
  yield* database.run(
    database.insert(personTable).values([
      { id: first.id, name: first.name, email: first.email },
      { id: second.id, name: second.name, email: second.email },
    ]),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  /** Auth middleware has already validated Membership; store tests exercise its resulting Actor. */
  const actor = (person: Person, workspace: Workspace): Actor => ({
    person,
    workspace,
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
  })
  const personal = actor(first, Workspace.cases.Personal.make({}))
  const other = actor(second, Workspace.cases.Personal.make({}))
  const inCompany = (person: Person, role: Role) =>
    actor(person, Workspace.cases.Company.make({ company, role }))
  return {
    personal,
    other,
    admin: inCompany(first, 'admin'),
    member: inCompany(second, 'member'),
    otherAdmin: inCompany(second, 'admin'),
  }
})

/** Public handlers receive the same validated Person context as an RPC call. */
const auth = (actor: Actor) =>
  AuthState.Person({
    person: actor.person,
    workspace: actor.workspace,
    sessionId: SessionId.make('skills-test'),
  })

describe.skipIf(!testDatabaseConfigured)('Skills', () => {
  layer(testLayer)((it) => {
    it.effect(
      'backfills existing skill descriptions from useWhen before enforcing the required column',
      () =>
        Effect.gen(function* () {
          const database = yield* Database
          const rows = yield* database.transaction((tx) =>
            Effect.gen(function* () {
              // A transaction-local shadow table exercises the generated SQL without altering app tables.
              yield* tx.execute(
                sql`CREATE TEMPORARY TABLE vivid_skills (use_when text NOT NULL) ON COMMIT DROP`,
              )
              yield* tx.execute(
                sql`INSERT INTO vivid_skills (use_when) VALUES (${'When the Person asks for a brief.'})`,
              )
              for (const name of [
                '20261002120142_tranquil_chameleon',
                '20261002120212_nebulous_moondragon',
              ]) {
                const migration = NodeFS.readFileSync(
                  new URL(`../../product-drizzle/${name}/migration.sql`, import.meta.url),
                  'utf8',
                )
                for (const statement of migration.split('--> statement-breakpoint'))
                  yield* tx.execute(sql.raw(statement))
              }
              return yield* tx.select({ about: skillTable.about }).from(skillTable)
            }),
          )
          expect(rows).toEqual([{ about: 'When the Person asks for a brief.' }])
        }),
    )

    it.effect(
      'lists shipped procedures beside same-name saved ones in scope',
      () =>
        Effect.gen(function* () {
          const { personal, other, admin, member } = yield* fixture()
          const store = yield* SkillStore
          const builtin = builtins[0]
          if (builtin === undefined) expect.fail('Shipped procedures are required')
          expect(yield* store.list(personal)).toEqual(builtins)
          // `catalogue` puts saved rows first and always appends every built-in: a saved procedure
          // sharing a shipped name coexists with it and never replaces it.
          const saved = yield* store.save(personal, { ...request, name: builtin.name })
          expect(saved.id).not.toBe(builtin.id)
          expect(SkillOrigin.guards.Saved(saved.origin)).toBe(true)
          expect(yield* store.list(personal)).toEqual([saved, ...builtins])
          expect(yield* store.list(other)).toEqual(builtins)
          const company = yield* store.save(admin, {
            ...request,
            name: builtin.name,
            forCompany: true,
          })
          // The Member sees the Company row but not the admin's personal one; outsiders see neither.
          expect(yield* store.list(member)).toEqual([company, ...builtins])
          expect(yield* store.list(personal)).toEqual([saved, ...builtins])
          expect(yield* store.list(other)).toEqual(builtins)
          expect(yield* store.read(personal, builtin.id)).toEqual(builtin)
          // A summary carries the saved routing rule verbatim; there is no override wording.
          const summaries = yield* skillHandlers
            .ListSkillSummaries()
            .pipe(Effect.provideService(AuthContext, auth(personal)))
          expect(summaries.skills).toEqual(
            [saved, ...builtins].map((skill) => ({
              id: skill.id,
              name: skill.name,
              useWhen: skill.useWhen,
              createdAt: skill.createdAt,
            })),
          )
          expect(saved.useWhen).toBe(request.useWhen)
        }),
    )

    it.effect('keeps a personal skill private and follows its owner into a Company', () =>
      Effect.gen(function* () {
        const { personal, other, admin, member } = yield* fixture()
        const store = yield* SkillStore
        const { skill } = yield* skillHandlers
          .SaveSkill(request)
          .pipe(Effect.provideService(AuthContext, auth(personal)))
        expect((yield* store.list(admin)).map((item) => item.id)).toContain(skill.id)
        expect(yield* store.list(other)).toEqual(builtins)
        expect(yield* store.list(member)).toEqual(builtins)
        const failure = yield* Effect.result(
          skillHandlers
            .ReadSkill({ id: skill.id })
            .pipe(Effect.provideService(AuthContext, auth(member))),
        )
        expect(Result.isFailure(failure)).toBe(true)
        if (Result.isFailure(failure)) expect(failure.failure._tag).toBe('NotFound')
        expect(skill.about).toBe(request.about)
        expect(SkillScope.guards.Personal(skill.scope)).toBe(true)
      }),
    )

    it.effect(
      'refuses Company saves by Members and permits admins, with scope-wide visibility',
      () =>
        Effect.gen(function* () {
          const { admin, member, other } = yield* fixture()
          const shared = { ...request, forCompany: true }
          const refused = yield* Effect.result(
            skillHandlers.SaveSkill(shared).pipe(Effect.provideService(AuthContext, auth(member))),
          )
          expect(Result.isFailure(refused)).toBe(true)
          if (Result.isFailure(refused)) expect(refused.failure._tag).toBe('Forbidden')
          const { skill } = yield* skillHandlers
            .SaveSkill(shared)
            .pipe(Effect.provideService(AuthContext, auth(admin)))
          const store = yield* SkillStore
          expect(SkillScope.guards.Company(skill.scope)).toBe(true)
          expect((yield* store.read(member, skill.id)).name).toBe(request.name)
          expect(yield* store.list(other)).toEqual(builtins)
        }),
    )

    it.effect('lets Vivid save for its Person while keeping Company administration required', () =>
      Effect.gen(function* () {
        const { personal, member } = yield* fixture()
        const vivid = AuthState.Vivid({
          person: personal.person,
          workspace: personal.workspace,
          threadId: ThreadId.make('skills-thread'),
        })
        const { skill } = yield* skillHandlers
          .SaveSkill(request)
          .pipe(Effect.provideService(AuthContext, vivid))
        expect(SkillOrigin.guards.Saved(skill.origin)).toBe(true)
        if (SkillOrigin.guards.Saved(skill.origin))
          expect(skill.origin.createdBy.id).toBe(personal.person.id)
        const memberCall = AuthState.Vivid({
          person: member.person,
          workspace: member.workspace,
          threadId: ThreadId.make('skills-thread'),
        })
        const refused = yield* Effect.result(
          skillHandlers
            .SaveSkill({ ...request, forCompany: true })
            .pipe(Effect.provideService(AuthContext, memberCall)),
        )
        expect(Result.isFailure(refused)).toBe(true)
        if (Result.isFailure(refused)) expect(refused.failure._tag).toBe('Forbidden')
      }),
    )

    it.effect('serializes competing saves and maps the duplicate name to Conflict', () =>
      Effect.gen(function* () {
        const { personal } = yield* fixture()
        const save = skillHandlers
          .SaveSkill(request)
          .pipe(Effect.provideService(AuthContext, auth(personal)), Effect.result)
        const outcomes = yield* Effect.all([save, save], { concurrency: 2 })
        expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
        const failures = outcomes.filter(Result.isFailure)
        expect(failures.map((result) => result.failure._tag)).toEqual(['Conflict'])
      }),
    )

    it.effect('permits equal names in different scopes', () =>
      Effect.gen(function* () {
        const { personal, admin } = yield* fixture()
        const store = yield* SkillStore
        const first = yield* store.save(personal, request)
        yield* store.save(admin, { ...request, forCompany: true })
        const second = yield* store.save(personal, { ...request, name: 'Another procedure' })
        expect(
          (yield* store.list(personal))
            .filter((skill) => !SkillOrigin.guards.BuiltIn(skill.origin))
            .map((skill) => skill.id)
            .toSorted(),
        ).toEqual([first.id, second.id].toSorted())
      }),
    )
  })
})

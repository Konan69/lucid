import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
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
      'lists shipped procedures, keeps overrides scoped and refuses built-in mutations',
      () =>
        Effect.gen(function* () {
          const { personal, other, admin, member } = yield* fixture()
          const store = yield* SkillStore
          const builtin = builtins[0]
          if (builtin === undefined) expect.fail('Shipped procedures are required')
          expect(yield* store.list(personal)).toEqual(builtins)
          const saved = yield* store.save(personal, { ...request, name: builtin.name })
          expect(
            (yield* store.list(personal)).filter((skill) => skill.name === builtin.name),
          ).toEqual([saved])
          expect((yield* store.list(other)).filter((skill) => skill.name === builtin.name)).toEqual(
            [builtin],
          )
          const company = yield* store.save(admin, {
            ...request,
            name: builtin.name,
            forCompany: true,
          })
          expect(
            (yield* store.list(member)).filter((skill) => skill.name === builtin.name),
          ).toEqual([company])
          expect((yield* store.list(other)).filter((skill) => skill.name === builtin.name)).toEqual(
            [builtin],
          )
          expect(yield* store.read(personal, builtin.id)).toEqual(builtin)
          const summaries = yield* skillHandlers
            .ListSkillSummaries()
            .pipe(Effect.provideService(AuthContext, auth(personal)))
          const summary = summaries.skills.find((skill) => skill.id === saved.id)
          if (summary === undefined) expect.fail('Saved procedure summary is required')
          expect(summary.useWhen).toContain('overrides')
          const patch = yield* skillHandlers
            .PatchSkill({ id: builtin.id, patch: { name: 'Changed' } })
            .pipe(Effect.provideService(AuthContext, auth(personal)), Effect.flip)
          expect(patch._tag).toBe('SkillReadOnly')
          const remove = yield* skillHandlers
            .DeleteSkill({ id: builtin.id })
            .pipe(Effect.provideService(AuthContext, auth(admin)), Effect.flip)
          expect(remove._tag).toBe('SkillReadOnly')
        }),
    )

    it.effect('summary discovery preserves creation order without fetching procedure bodies', () =>
      Effect.gen(function* () {
        const { personal } = yield* fixture()
        const { skill } = yield* skillHandlers
          .SaveSkill(request)
          .pipe(Effect.provideService(AuthContext, auth(personal)))
        const { skills } = yield* skillHandlers
          .ListSkillSummaries()
          .pipe(Effect.provideService(AuthContext, auth(personal)))
        expect(skills).toContainEqual({
          id: skill.id,
          name: skill.name,
          useWhen: skill.useWhen,
          createdAt: skill.createdAt,
        })
        expect(skills).toHaveLength(builtins.length + 1)
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

    it.effect('allows an owner or Company admin to edit and delete, but not a Member', () =>
      Effect.gen(function* () {
        const { admin, member, otherAdmin } = yield* fixture()
        const { skill } = yield* skillHandlers
          .SaveSkill({ ...request, forCompany: true })
          .pipe(Effect.provideService(AuthContext, auth(admin)))
        const refused = yield* Effect.result(
          skillHandlers
            .PatchSkill({ id: skill.id, patch: { name: 'Renamed' } })
            .pipe(Effect.provideService(AuthContext, auth(member))),
        )
        expect(Result.isFailure(refused)).toBe(true)
        if (Result.isFailure(refused)) expect(refused.failure._tag).toBe('Forbidden')
        const patched = yield* skillHandlers
          .PatchSkill({ id: skill.id, patch: { name: 'Renamed' } })
          .pipe(Effect.provideService(AuthContext, auth(otherAdmin)))
        expect(patched.skill.name).toBe('Renamed')
        expect(patched.skill.instructions).toBe(request.instructions)
        const deletion = yield* Effect.result(
          skillHandlers
            .DeleteSkill({ id: skill.id })
            .pipe(Effect.provideService(AuthContext, auth(member))),
        )
        expect(Result.isFailure(deletion)).toBe(true)
        if (Result.isFailure(deletion)) expect(deletion.failure._tag).toBe('Forbidden')
        yield* skillHandlers
          .DeleteSkill({ id: skill.id })
          .pipe(Effect.provideService(AuthContext, auth(otherAdmin)))
        expect(yield* (yield* SkillStore).list(admin)).toEqual(builtins)
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

    it.effect('permits equal names in different scopes but rejects a colliding rename', () =>
      Effect.gen(function* () {
        const { personal, admin } = yield* fixture()
        const store = yield* SkillStore
        const first = yield* store.save(personal, request)
        yield* store.save(admin, { ...request, forCompany: true })
        const second = yield* store.save(personal, { ...request, name: 'Another procedure' })
        const renamed = yield* Effect.result(
          skillHandlers
            .PatchSkill({ id: second.id, patch: { name: first.name } })
            .pipe(Effect.provideService(AuthContext, auth(personal))),
        )
        expect(Result.isFailure(renamed)).toBe(true)
        if (Result.isFailure(renamed)) expect(renamed.failure._tag).toBe('Conflict')
        yield* store.patch(personal, first.id, { instructions: 'Updated steps' })
        expect((yield* store.read(personal, first.id)).instructions).toBe('Updated steps')
        yield* store.remove(personal, first.id)
        expect(
          (yield* store.list(personal))
            .filter((skill) => !SkillOrigin.guards.BuiltIn(skill.origin))
            .map((skill) => skill.id),
        ).toEqual([second.id])
      }),
    )
  })
})

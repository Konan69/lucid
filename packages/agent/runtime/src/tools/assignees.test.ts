import { describe, expect, it } from '@effect/vitest'
import {
  Assignee,
  AssigneeInput,
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  InvalidRequest,
  Member,
  MembershipId,
  NotFound,
  PeopleResponse,
  PersonId,
  PersonSummary,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { RpcClientDefect, RpcClientError } from 'effect/unstable/rpc/RpcClientError'
import { assigneeName, resolveAssignee, resolveFor } from './assignees.ts'
import { settle } from './result.ts'

/** Directory fixtures keep a Membership separate from the Person it names. */
function member(id: string, name: string) {
  return Member.make({
    membershipId: MembershipId.make(`membership-${id}`),
    person: PersonSummary.make({ id: PersonId.make(id), name, image: null }),
    email: `${id}@example.test`,
    role: 'member',
    joinedAt: 0,
  })
}

const ada = member('ada', 'Ada Obi')
const people = [ada, member('dami', 'Dami')] as const

describe('assignee resolution', () => {
  it.effect('resolves only a unique exact case-insensitive Member name', () =>
    Effect.sync(() => {
      expect(resolveAssignee(Option.some('  ADA oBI  '), people)).toEqual(
        AssigneeInput.cases.Member.make({ personId: ada.person.id }),
      )
      expect(resolveAssignee(Option.some('Ada'), people)).toEqual(
        AssigneeInput.cases.Outsider.make({ name: 'Ada' }),
      )
    }),
  )

  it.effect('keeps duplicate names, absent directory access and unknown names as Outsiders', () =>
    Effect.sync(() => {
      expect(resolveAssignee(Option.some('Dami'), [...people, member('another', 'dami')])).toEqual(
        AssigneeInput.cases.Outsider.make({ name: 'Dami' }),
      )
      expect(resolveAssignee(Option.some('Ada Obi'), [])).toEqual(
        AssigneeInput.cases.Outsider.make({ name: 'Ada Obi' }),
      )
      expect(resolveAssignee(Option.some('  Nneka  '), people)).toEqual(
        AssigneeInput.cases.Outsider.make({ name: 'Nneka' }),
      )
    }),
  )

  it.effect('treats absent input and self references as the creator’s own work', () =>
    Effect.sync(() => {
      for (const name of [Option.none<string>(), Option.some(' Me '), Option.some('YOU')]) {
        expect(resolveAssignee(name, [member('me', 'me'), ...people])).toEqual(
          AssigneeInput.cases.Nobody.make({}),
        )
      }
    }),
  )

  it.effect('reports saved assignees as names rather than directory identifiers', () =>
    Effect.sync(() => {
      expect(assigneeName(Assignee.cases.Member.make({ person: ada.person }))).toBe('Ada Obi')
      expect(assigneeName(Assignee.cases.Outsider.make({ name: 'Nneka' }))).toBe('Nneka')
      expect(assigneeName(Assignee.cases.Nobody.make({}))).toBe('you')
    }),
  )
})

describe('assignee directory failures', () => {
  it.effect('resolves the directory before choosing a Member', () =>
    Effect.gen(function* () {
      expect(
        yield* resolveFor(
          Option.some('ADA OBI'),
          Effect.succeed(PeopleResponse.make({ members: people, invitations: [] })),
        ),
      ).toEqual(AssigneeInput.cases.Member.make({ personId: ada.person.id }))
    }),
  )

  it.effect('permits an Outsider only when directory access is Forbidden', () =>
    Effect.gen(function* () {
      expect(
        yield* resolveFor(
          Option.some('Ada Obi'),
          Effect.fail(new Forbidden({ message: 'Personal space has no Company directory' })),
        ),
      ).toEqual(AssigneeInput.cases.Outsider.make({ name: 'Ada Obi' }))
    }),
  )

  it.effect('preserves all other declared failures and transport failures', () =>
    Effect.gen(function* () {
      const message = 'Directory unavailable'
      const failures = [
        new NotFound({ message }),
        new Unauthenticated({ message }),
        new Conflict({ message }),
        new InvalidRequest({ message }),
        new RuntimeUnavailable({ message }),
        new DatabaseUnavailable({ message }),
        new DatabaseConstraintViolation({ message }),
        new DatabaseFailure({ message }),
        new ServiceUnavailable({ service: 'memory', message }),
        new RpcClientError({ reason: new RpcClientDefect({ message, cause: null }) }),
      ]
      for (const failure of failures) {
        expect(yield* Effect.flip(resolveFor(Option.some('Ada Obi'), Effect.fail(failure)))).toBe(
          failure,
        )
      }
    }),
  )

  it.effect('stops the Task program on a transient failure and returns its safe sentence', () =>
    Effect.gen(function* () {
      let resolved = false
      const program = resolveFor(
        Option.some('Ada Obi'),
        Effect.fail(new DatabaseUnavailable({ message: 'Private database driver detail' })),
      ).pipe(
        Effect.map((assignee) => {
          resolved = true
          return { output: { assignee } }
        }),
      )
      expect(yield* settle(program)).toEqual({
        output: { ok: false, message: 'Vivid cannot reach its saved records right now.' },
        terminate: false,
      })
      expect(resolved).toBe(false)
    }),
  )

  it.effect('does not read a failing directory for absent names or self references', () =>
    Effect.gen(function* () {
      for (const name of [Option.none<string>(), Option.some(' Me '), Option.some('YOU')]) {
        expect(
          yield* resolveFor(
            name,
            Effect.fail(new DatabaseUnavailable({ message: 'Directory unavailable' })),
          ),
        ).toEqual(AssigneeInput.cases.Nobody.make({}))
      }
    }),
  )
})

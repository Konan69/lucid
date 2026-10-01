import { describe, expect, it } from '@effect/vitest'
import {
  Assignee,
  AssigneeInput,
  Member,
  MembershipId,
  PersonId,
  PersonSummary,
} from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { assigneeName, resolveAssignee } from './assignees.ts'

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

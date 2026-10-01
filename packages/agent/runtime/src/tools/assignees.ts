import * as Option from 'effect/Option'
import { Assignee, AssigneeInput, type Member } from '@vivid/contracts'

/** Only one exact case-insensitive Member name grants a Member identity; ambiguous names stay outside. */
export function resolveAssignee(
  name: Option.Option<string>,
  people: ReadonlyArray<Member>,
): AssigneeInput {
  if (Option.isNone(name)) return AssigneeInput.cases.Nobody.make({})
  const normalized = name.value.trim().toLowerCase()
  if (normalized === '' || normalized === 'me' || normalized === 'you')
    return AssigneeInput.cases.Nobody.make({})
  const matches = people.filter((member) => member.person.name.toLowerCase() === normalized)
  const [member] = matches
  if (matches.length === 1 && member !== undefined)
    return AssigneeInput.cases.Member.make({ personId: member.person.id })
  return AssigneeInput.cases.Outsider.make({ name: name.value.trim() })
}

/** Nobody is the creator's own work, while named assignees are returned as names rather than ids. */
export function assigneeName(assignee: Assignee): string {
  return Assignee.match(assignee, {
    Nobody: () => 'you',
    Member: ({ person }) => person.name,
    Outsider: ({ name }) => name,
  })
}

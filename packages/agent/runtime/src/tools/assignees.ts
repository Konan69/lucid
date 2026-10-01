import * as Option from 'effect/Option'
import * as Effect from 'effect/Effect'
import type { RpcClientError } from 'effect/unstable/rpc/RpcClientError'
import { Assignee, AssigneeInput, type Member, type PeopleResponse } from '@vivid/contracts'
import type { RpcFailure } from '@vivid/contracts/rpc'

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

/** Personal spaces have no directory; other failures must stop the Task rather than misidentify a Member. */
export const resolveFor = Effect.fn('Tools.resolveAssignee')(function* (
  name: Option.Option<string>,
  directory: Effect.Effect<PeopleResponse, RpcFailure | RpcClientError>,
) {
  if (Option.isNone(name) || ['me', 'you'].includes(name.value.trim().toLowerCase()))
    return resolveAssignee(name, [])
  const people = yield* directory.pipe(
    Effect.map((response) => response.members),
    Effect.catchTag('Forbidden', () => Effect.succeed([])),
  )
  return resolveAssignee(name, people)
})

/** Nobody is the creator's own work, while named assignees are returned as names rather than ids. */
export function assigneeName(assignee: Assignee): string {
  return Assignee.match(assignee, {
    Nobody: () => 'you',
    Member: ({ person }) => person.name,
    Outsider: ({ name }) => name,
  })
}

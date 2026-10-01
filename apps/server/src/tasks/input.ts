import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  AssigneeInput,
  InvalidRequest,
  Workspace,
  FollowUpId,
  type FollowUpInput,
  type PersonId,
  type TimestampInput,
} from '@vivid/contracts'
import { type Actor } from '../auth/access.ts'
import { membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'

const isNumber = Schema.is(Schema.Number)

/** Reject invalid timestamps at mutation ingress before PostgreSQL receives NaN. */
export const timestamp = (input: TimestampInput) => {
  const value = isNumber(input) ? input : Date.parse(input)
  return Number.isFinite(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new InvalidRequest({
          message: 'Timestamp must be finite epoch milliseconds or an ISO timestamp',
        }),
      )
}

interface AssignmentColumns {
  readonly assignee: string | null
  readonly assigneePersonId: PersonId | null
}

/** A Member assignment is a tenancy relation, never a bare Person id accepted on trust. */
export const assignment = Effect.fn('Tasks.assignment')(function* (
  actor: Actor,
  input: AssigneeInput,
) {
  return yield* AssigneeInput.match(input, {
    Nobody: () => Effect.succeed<AssignmentColumns>({ assignee: null, assigneePersonId: null }),
    Outsider: ({ name }) =>
      Effect.succeed<AssignmentColumns>({ assignee: name, assigneePersonId: null }),
    Member: Effect.fn('Tasks.assignMember')(function* ({
      personId,
    }): Effect.fn.Return<
      AssignmentColumns,
      | import('@vivid/contracts').InvalidRequest
      | import('../database/client.ts').DatabaseInfrastructureError,
      Database
    > {
      if (Workspace.guards.Personal(actor.workspace)) {
        if (personId !== actor.person.id)
          return yield* Effect.fail(
            new InvalidRequest({ message: 'Assignee must belong to this workspace' }),
          )
      } else {
        const database = yield* Database
        const members = yield* database.run(
          database
            .select({ id: membershipTable.id })
            .from(membershipTable)
            .where(
              and(
                eq(membershipTable.companyId, actor.workspace.company.id),
                eq(membershipTable.userId, personId),
              ),
            )
            .limit(1),
        )
        if (members.length === 0)
          return yield* Effect.fail(
            new InvalidRequest({ message: 'Assignee must be a Member of this Company' }),
          )
      }
      return { assignee: null, assigneePersonId: personId }
    }),
  })
})

/** Input normalization happens before writes so a bad schedule cannot leave a partially created Task. */
export const scheduleInput = Effect.fn('Tasks.scheduleInput')(function* (input: FollowUpInput) {
  if (
    input.repeatEveryMs !== undefined &&
    input.repeatEveryMs !== null &&
    (!Number.isFinite(input.repeatEveryMs) || input.repeatEveryMs <= 0)
  ) {
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Repeat interval must be positive finite milliseconds' }),
    )
  }
  return {
    id: input.id === undefined ? FollowUpId.make(crypto.randomUUID()) : input.id,
    at: yield* timestamp(input.at),
    note: input.note === undefined ? '' : input.note,
    repeatEveryMs: input.repeatEveryMs === undefined ? null : input.repeatEveryMs,
  }
})

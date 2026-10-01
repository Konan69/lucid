import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  Assignee,
  Author,
  CompanyId,
  DatabaseFailure,
  FollowUp,
  PersonId,
  RoutineId,
  RunId,
  Task,
  TaskId,
  TaskStatus,
  TaskPriority,
  TaskOrigin,
  ThreadId,
  type PersonSummary,
} from '@vivid/contracts'
import { type Actor, loadSummaries } from '../auth/access.ts'
import { decodeStored } from '../database/client.ts'
import { followUps, tasks } from './tables.ts'

/** Persisted ownership stays available to background delivery even though Task's wire view omits it. */
export const StoredTask = createSelectSchema(tasks).mapFields((fields) => ({
  ...fields,
  id: TaskId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  assigneePersonId: Schema.NullOr(PersonId),
  conversationId: ThreadId,
  createdBy: Schema.Literals(['person', 'vivid']),
  status: TaskStatus,
  priority: TaskPriority,
}))
export type StoredTask = typeof StoredTask.Type
export const decodeTaskRow = decodeStored(StoredTask, 'Task')
/** Follow-ups can be created by another visible Member; persist that identity in the existing text column. */
const FollowUpAuthor = Schema.TaggedUnion({
  Person: { personId: PersonId },
  Vivid: { personId: PersonId },
})
const followUpAuthorJson = Schema.fromJsonString(FollowUpAuthor)
const encodeFollowUpAuthor = Schema.encodeSync(followUpAuthorJson)
const decodeFollowUpAuthor = decodeStored(followUpAuthorJson, 'follow-up author')

/** Encode attribution at persistence egress so editing someone else's Task never borrows their identity. */
export const storedFollowUpAuthor = (actor: Actor) =>
  encodeFollowUpAuthor(
    actor.by === 'person'
      ? FollowUpAuthor.cases.Person.make({ personId: actor.person.id })
      : FollowUpAuthor.cases.Vivid.make({ personId: actor.person.id }),
  )

/** A delivery has either a receipt or an expected failure; incompatible nullable fields cannot compile. */
export const DeliveryOutcome = Schema.TaggedUnion({
  Delivered: { runId: RunId },
  Failed: { message: Schema.String },
})
export type DeliveryOutcome = typeof DeliveryOutcome.Type

/** Only the writer that records the claim's outcome emits its notification. */
export const DeliveryRecord = Schema.TaggedUnion({
  Recorded: { followUp: FollowUp },
  Unchanged: { followUp: FollowUp },
})

const decodeFollowUpRow = decodeStored(createSelectSchema(followUps), 'follow-up')
const decodeFollowUpView = decodeStored(FollowUp, 'follow-up')
const decodeOrigin = decodeStored(TaskOrigin, 'Task origin')
const decodeTaskView = decodeStored(Task, 'Task')

/** A missing Person is corrupt persistence, never a fabricated identity on a shared Task. */
const summary = (summaries: ReadonlyMap<PersonId, PersonSummary>, id: PersonId) => {
  const person = summaries.get(id)
  return person === undefined
    ? Effect.fail(new DatabaseFailure({ message: 'Task references a missing Person' }))
    : Effect.succeed(person)
}

/** Persisted author values are closed; old or invalid values must be repaired rather than aliased. */
const author = (by: string, person: PersonSummary) => {
  if (by === 'person') return Effect.succeed(Author.cases.Person.make({ person }))
  if (by === 'vivid') return Effect.succeed(Author.cases.Vivid.make({ onBehalfOf: person }))
  return Effect.fail(new DatabaseFailure({ message: 'Task has an invalid author' }))
}

/** Decode the persisted author once, then resolve their current public summary. */
export const projectFollowUp = Effect.fn('Tasks.projectFollowUp')(function* (
  value: typeof followUps.$inferSelect,
) {
  const row = yield* decodeFollowUpRow(value)
  const stored = yield* decodeFollowUpAuthor(row.createdBy)
  const people = yield* loadSummaries([stored.personId])
  const person = yield* summary(people, stored.personId)
  const createdBy = FollowUpAuthor.match(stored, {
    Person: (): Author => Author.cases.Person.make({ person }),
    Vivid: (): Author => Author.cases.Vivid.make({ onBehalfOf: person }),
  })
  return yield* decodeFollowUpView({ ...row, createdBy })
})

/** Exactly one assignment column may be populated; incompatible stored columns are a database fault. */
const projectAssignee = Effect.fn('Tasks.projectAssignee')(function* (row: StoredTask) {
  if (row.assigneePersonId !== null) {
    if (row.assignee !== null)
      return yield* Effect.fail(new DatabaseFailure({ message: 'Task has two assignees' }))
    const people = yield* loadSummaries([row.assigneePersonId])
    return Assignee.cases.Member.make({ person: yield* summary(people, row.assigneePersonId) })
  }
  if (row.assignee !== null) return Assignee.cases.Outsider.make({ name: row.assignee })
  return Assignee.cases.Nobody.make({})
})

/** Origin columns are decoded exhaustively so a missing relation cannot silently become manual. */
const projectOrigin = (row: StoredTask) => {
  if (row.originKind === 'manual' && row.originId === null) return decodeOrigin({ kind: 'manual' })
  if (row.originKind === 'thread' && row.originId !== null)
    return decodeOrigin({ kind: 'thread', threadId: row.originId })
  if (row.originKind === 'routine' && row.originId !== null)
    return decodeOrigin({ kind: 'routine', routineId: row.originId })
  return Effect.fail(new DatabaseFailure({ message: 'Task has an invalid origin' }))
}

/** Builds the transport-neutral projection from decoded rows and attributed follow-ups. */
export const projectTask = Effect.fn('Tasks.projectTask')(function* (
  row: StoredTask,
  taskFollowUps: ReadonlyArray<FollowUp>,
) {
  const people = yield* loadSummaries([row.personId])
  const createdBy = yield* author(row.createdBy, yield* summary(people, row.personId))
  const assignee = yield* projectAssignee(row)
  const origin = yield* projectOrigin(row)
  const scheduled = taskFollowUps.flatMap((item) => (item.status === 'scheduled' ? [item.at] : []))
  return yield* decodeTaskView({
    ...row,
    threadId: row.conversationId,
    createdBy,
    assignee,
    origin,
    followUps: taskFollowUps,
    nextFollowUpAt: scheduled.length === 0 ? null : Math.min(...scheduled),
  })
})

/** The Routine prefix remains the established relation for a Routine's reporting Thread. */
export const originOf = (threadId: ThreadId, manual: boolean): TaskOrigin => {
  if (manual) return { kind: 'manual' }
  if (threadId.startsWith('routine-'))
    return { kind: 'routine', routineId: RoutineId.make(threadId.slice('routine-'.length)) }
  return { kind: 'thread', threadId }
}

/** Normalize the closed origin variants to the persistence relation column. */
export const originColumn = (origin: TaskOrigin) => {
  if (origin.kind === 'manual') return null
  if (origin.kind === 'thread') return origin.threadId
  return origin.routineId
}

import { and, eq, exists, or } from 'drizzle-orm'
import { Workspace } from '@vivid/contracts'
import { inWorkspace, ownedHere, type Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { threadParticipants, threads } from '../threads/tables.ts'
import { Changes, Topic } from '../live/changes.ts'
import { type StoredTask } from './projection.ts'
import { tasks } from './tables.ts'

/** Company roles grant no access to private work; ownership, assignment and Thread audience do. */
export const visible = (database: Database['Service'], actor: Actor) => {
  if (Workspace.guards.Personal(actor.workspace)) return ownedHere(tasks, actor)
  const participant = database
    .select({ id: threadParticipants.threadId })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threads.id),
        eq(threadParticipants.personId, actor.person.id),
      ),
    )
  return and(
    inWorkspace(tasks, actor),
    or(
      eq(tasks.personId, actor.person.id),
      eq(tasks.assigneePersonId, actor.person.id),
      and(
        inWorkspace(threads, actor),
        or(
          eq(threads.audience, 'company'),
          eq(threads.personId, actor.person.id),
          and(eq(threads.audience, 'people'), exists(participant)),
        ),
      ),
    ),
  )
}

/** Subqueries preserve the same visibility rule in updates and deletes without in-memory filtering. */
export const visibleIds = (database: Database['Service'], actor: Actor) =>
  database
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(threads, eq(tasks.conversationId, threads.id))
    .where(visible(database, actor))

/** Background mutations publish the stored owner and Company, never the scheduler's identity. */
export const publishTask = (changes: Changes['Service'], task: StoredTask) => {
  const topics = [Topic.person(task.personId), Topic.thread(task.conversationId)]
  if (task.companyId !== null) topics.push(Topic.company(task.companyId))
  return changes.publish(topics)
}

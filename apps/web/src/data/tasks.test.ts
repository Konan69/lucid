import {
  Assignee,
  AssigneeInput,
  Author,
  FollowUpId,
  NotificationId,
  PersonId,
  TaskId,
  ThreadId,
  type FollowUp,
  type Notification,
  type PersonSummary,
  type Task,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  assigneeInput,
  authorName,
  bucketOf,
  draftTask,
  fieldsDiffer,
  fieldsOf,
  followUpAdded,
  followUpRemoved,
  followUpSet,
  groupOpen,
  notificationsRead,
  scheduledFollowUp,
  statusSet,
} from './tasks'

const person = (id: string, name: string): PersonSummary => ({
  id: PersonId.make(id),
  name,
  image: null,
})
const ada = person('ada', 'Ada')
const dami = person('dami', 'Dami')

const NOW = Date.UTC(2026, 9, 1, 12)
const HOUR = 3_600_000

/** A Task Ada made for herself, changed per test to the one thing the test is about. */
const task = (id: string, changes: Partial<Task>): Task => ({
  id: TaskId.make(id),
  title: id,
  detail: '',
  status: 'open',
  priority: 'normal',
  assignee: Assignee.cases.Nobody.make({}),
  dueAt: null,
  origin: { kind: 'manual' },
  createdBy: Author.cases.Person.make({ person: ada }),
  threadId: ThreadId.make(`thread-${id}`),
  overdueNotifiedAt: null,
  completedAt: null,
  createdAt: NOW - 24 * HOUR,
  updatedAt: NOW - 24 * HOUR,
  followUps: [],
  nextFollowUpAt: null,
  ...changes,
})

const followUp = (id: string, taskId: string, changes: Partial<FollowUp>): FollowUp => ({
  id: FollowUpId.make(id),
  taskId: TaskId.make(taskId),
  at: NOW + HOUR,
  note: '',
  repeatEveryMs: null,
  status: 'scheduled',
  submissionId: null,
  firedAt: null,
  output: null,
  error: null,
  createdBy: Author.cases.Person.make({ person: ada }),
  createdAt: NOW,
  ...changes,
})

describe('bucketOf', () => {
  it('keeps a Task the Person made for themselves as theirs', () => {
    expect(bucketOf(task('own', {}), ada.id)).toBe('Yours')
  })

  it('keeps a Task Vivid made for the Person, assigned to nobody, as theirs', () => {
    const made = task('vivid', { createdBy: Author.cases.Vivid.make({ onBehalfOf: ada }) })
    expect(bucketOf(made, ada.id)).toBe('Yours')
  })

  it('marks a Task another Member assigned to the Person as assigned to them', () => {
    const handed = task('handed', {
      createdBy: Author.cases.Person.make({ person: dami }),
      assignee: Assignee.cases.Member.make({ person: ada }),
    })
    expect(bucketOf(handed, ada.id)).toBe('Assigned')
  })

  it('treats a Task owed by another Member or by an Outsider as waiting on them', () => {
    const member = task('member', { assignee: Assignee.cases.Member.make({ person: dami }) })
    const outsider = task('outsider', { assignee: Assignee.cases.Outsider.make({ name: 'Kemi' }) })
    expect(bucketOf(member, ada.id)).toBe('Waiting')
    expect(bucketOf(outsider, ada.id)).toBe('Waiting')
  })

  it('treats an unassigned Task another Member made, seen through a shared Thread, as waiting on them', () => {
    const theirs = task('theirs', { createdBy: Author.cases.Person.make({ person: dami }) })
    expect(bucketOf(theirs, ada.id)).toBe('Waiting')
  })
})

describe('groupOpen', () => {
  it('orders each group overdue first, then by due time, then undated newest first', () => {
    const groups = groupOpen(
      [
        task('undated-old', { createdAt: NOW - 48 * HOUR }),
        task('due-later', { dueAt: NOW + 5 * HOUR }),
        task('undated-new', { createdAt: NOW - HOUR }),
        task('overdue', { dueAt: NOW - HOUR }),
        task('long-overdue', { dueAt: NOW - 30 * HOUR }),
      ],
      ada.id,
    )
    expect(groups.map((group) => group.bucket)).toEqual(['Yours'])
    expect(groups.flatMap((group) => group.tasks.map((item) => item.id))).toEqual([
      'long-overdue',
      'overdue',
      'due-later',
      'undated-new',
      'undated-old',
    ])
  })

  it('leaves settled Tasks out and omits a group with nothing open in it', () => {
    const groups = groupOpen(
      [
        task('done', { status: 'done' }),
        task('waiting', { assignee: Assignee.cases.Outsider.make({ name: 'Kemi' }) }),
      ],
      ada.id,
    )
    expect(groups.map((group) => [group.bucket, group.tasks.length])).toEqual([['Waiting', 1]])
  })
})

describe('assignees', () => {
  it('names a Member by id and trims an Outsider', () => {
    expect(assigneeInput(Assignee.cases.Member.make({ person: dami }))).toEqual(
      Option.some(AssigneeInput.cases.Member.make({ personId: dami.id })),
    )
    expect(assigneeInput(Assignee.cases.Outsider.make({ name: '  Kemi ' }))).toEqual(
      Option.some(AssigneeInput.cases.Outsider.make({ name: 'Kemi' })),
    )
  })

  it('has nothing to send for an Outsider whose name has not been typed', () => {
    expect(Option.isNone(assigneeInput(Assignee.cases.Outsider.make({ name: '   ' })))).toBe(true)
  })

  it('says a Task made by Vivid was made for the Person it acted for', () => {
    expect(authorName(Author.cases.Vivid.make({ onBehalfOf: dami }))).toBe('Vivid, for Dami')
  })

  it('sees a changed assignee as an edit and surrounding spaces as none', () => {
    const current = task('edit', { assignee: Assignee.cases.Outsider.make({ name: 'Kemi' }) })
    const fields = fieldsOf(current)
    expect(
      fieldsDiffer(current, {
        ...fields,
        assignee: Assignee.cases.Outsider.make({ name: ' Kemi ' }),
      }),
    ).toBe(false)
    expect(
      fieldsDiffer(current, { ...fields, assignee: Assignee.cases.Member.make({ person: dami }) }),
    ).toBe(true)
  })
})

describe('expectations', () => {
  it('completes one Task in place and reopening clears its completion time', () => {
    const list = { tasks: [task('a', {}), task('b', {})] }
    const done = statusSet(TaskId.make('a'), 'done', NOW)(list)
    expect(done.tasks.map((item) => [item.id, item.status, item.completedAt])).toEqual([
      ['a', 'done', NOW],
      ['b', 'open', null],
    ])
    const reopened = statusSet(TaskId.make('a'), 'open', NOW + 1)(done)
    expect(reopened.tasks.map((item) => item.completedAt)).toEqual([null, null])
  })

  it('keeps the next follow-up time in step as follow-ups are added, started and removed', () => {
    const later = followUp('later', 'a', { at: NOW + 5 * HOUR })
    const sooner = followUp('sooner', 'a', { at: NOW + HOUR })
    const list = { tasks: [task('a', {})] }
    const added = followUpAdded(sooner)(followUpAdded(later)(list))
    expect(added.tasks.map((item) => item.nextFollowUpAt)).toEqual([NOW + HOUR])

    // A follow-up that is running is no longer waiting for its time.
    const started = followUpSet(TaskId.make('a'), sooner.id, 'running')(added)
    expect(started.tasks.map((item) => item.nextFollowUpAt)).toEqual([NOW + 5 * HOUR])

    const removed = followUpRemoved(TaskId.make('a'), later.id)(started)
    expect(removed.tasks.map((item) => item.nextFollowUpAt)).toEqual([null])
  })

  it('drafts a new Task as its creator will see it, with its first follow-up scheduled', () => {
    const id = TaskId.make('new')
    const first = { id: FollowUpId.make('first'), at: NOW + HOUR, note: 'Ask', repeatEveryMs: null }
    const drafted = draftTask(
      id,
      {
        fields: {
          title: '  Call Kemi ',
          detail: '',
          assignee: Assignee.cases.Outsider.make({ name: ' Kemi ' }),
          dueAt: null,
          priority: 'urgent',
        },
        followUp: Option.some(first),
      },
      { me: ada, now: NOW },
    )
    expect(drafted.title).toBe('Call Kemi')
    expect(drafted.assignee).toEqual(Assignee.cases.Outsider.make({ name: 'Kemi' }))
    expect(bucketOf(drafted, ada.id)).toBe('Waiting')
    expect(drafted.followUps).toEqual([scheduledFollowUp(id, first, { me: ada, now: NOW })])
    expect(drafted.nextFollowUpAt).toBe(NOW + HOUR)
  })
})

describe('notificationsRead', () => {
  const notification = (id: string, readAt: number | null): Notification => ({
    id: NotificationId.make(id),
    kind: 'assigned',
    title: id,
    body: '',
    taskId: null,
    threadId: null,
    createdAt: NOW - HOUR,
    readAt,
  })
  const list = {
    notifications: [notification('a', null), notification('b', null), notification('c', NOW - 5)],
    unreadCount: 2,
  }

  it('marks only the opened notification read and recounts', () => {
    const next = notificationsRead(Option.some([NotificationId.make('a')]), NOW)(list)
    expect(next.notifications.map((item) => item.readAt)).toEqual([NOW, null, NOW - 5])
    expect(next.unreadCount).toBe(1)
  })

  it('marks everything unread as read without touching when the rest were read', () => {
    const next = notificationsRead(Option.none(), NOW)(list)
    expect(next.notifications.map((item) => item.readAt)).toEqual([NOW, NOW, NOW - 5])
    expect(next.unreadCount).toBe(0)
  })
})

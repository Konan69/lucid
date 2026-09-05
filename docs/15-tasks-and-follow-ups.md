# Tasks and follow-ups

**Status:** Designed and built locally, 3 September 2026. Driven by investor feedback that Vivid
should be more proactive: hold tasks, tell people, and follow up on work without being asked twice.

## What this is

Vivid keeps a task list and chases it. A task is a piece of work that someone owes: you, or a
person you name. A follow-up is a moment when Vivid wakes up on its own, looks at the task, and
acts: it reminds you, drafts the nudge for the person the work waits on, or closes the task if it
is finished. Notifications are how those wakes reach you inside the app. None of this requires a
connector; the loop is complete with the app alone.

This is not knowledge work. It is the teammate behaviour of remembering, nagging, and reporting.

## Shape

```text
Task
├── Title, optional detail
├── Status: open · done · dropped
├── Priority: normal · urgent
├── Assignee: you (null) or a named person
├── Due date (optional)
├── Origin: the conversation or routine that created it, or manual
├── Created by: you or Vivid
└── Its own conversation (task-<id>) where Vivid follows up

Follow-up (belongs to a task)
├── When (a timestamp)
├── Note: what to check or say
├── Repeat: none, or every N ms (daily, weekly)
├── Status: scheduled · running · fired · cancelled · failed
├── Flue submission id (once durably admitted)
└── Output: what Vivid said when it fired

Notification
├── Kind: tracked · overdue · follow-up · follow-up-failed
├── Title and body
├── Links to a task and a conversation
└── Read state
```

## Behaviour

- **Vivid creates tasks in conversation.** Four tools are mounted on the agent: `create_task`,
  `update_task`, `list_tasks`, `schedule_follow_up`. The instruction tells Vivid to offer tracking
  when work depends on someone else, has a deadline, or should be checked later, and never to file
  work it can finish now. The origin conversation id is closed over from the agent's own `props.id`.
- **Follow-ups wake Vivid.** A single in-process ticker (every 20 s) fires due follow-ups. Each fire
  dispatches a durable `follow-up` signal into the task's conversation, the same way routines
  dispatch `schedule` signals. Vivid's reply is stored on the follow-up, becomes a notification, and
  the conversation shows up in the sidebar like any other thread.
- **Overdue work is chased automatically.** When an open task passes its due date, Vivid records an
  `overdue` notification once and, if no follow-up is covering the task, creates and runs one. A
  follow-up covers the task when it is scheduled, running, or fired within the hour before the due
  time, so the default case (follow-up at the due time) is chased once, not twice. This is the
  "invasive" behaviour the investor asked for, bounded to one automatic chase per task.
- **You can chase now.** Any task has a "Chase now" action that runs a follow-up immediately.
  "Run now" on a follow-up that already fired or failed is a retry: the row goes back to scheduled
  with a fresh Flue submission (idempotency key is per run, not per row).
- **Repeat is a new row.** A repeating follow-up schedules its successor when it fires, so the run
  history stays intact and cancelling the future one leaves the past alone.
- **Interrupted runs reattach.** A running follow-up persists Flue's submission id. On restart,
  Vivid calls `read(submissionId)` and waits for the same durable submission instead of prompting
  again. If the process died after admission but before saving the receipt, redispatch uses the
  follow-up id as Flue's stable idempotency key and converges on the original submission.
- **Completion is idempotent.** The fired state and notification commit together, guarded by the
  running state, so two recovery paths cannot publish the same result twice. Routine runs use the
  same persisted-submission and reattachment pattern.
- **Agent-authored task writes are durable tools.** Mutating task tools wrap their SQLite effects in
  Flue `step.do` checkpoints. Their row ids are deterministic UUIDs derived from the tool-call id,
  making the at-least-once execution boundary safe to replay without duplicate tasks, follow-ups,
  or notifications.

## Runtime note: the instruction must be stable within a response

Flue re-renders the agent before every model call and narrates any change to the instruction
document as a "System instructions updated" signal. Putting the current time in the instruction
made every render differ, so each turn produced a new signal, the model acknowledged it, and the
response never settled (a follow-up sat in `running` until aborted). The instruction now carries
the date at day granularity only; exact times reach the model through tool results. Anything that
varies per render belongs in a tool result, a delivered signal, or `useAgentStart`'s `append`.

## What Vivid does not claim

- It does not message another person on its own. It drafts the nudge; you send it, or you ask it to
  send through the Gmail connector (see PR #1, `packages/connectors`). Tool results are the only
  proof of delivery. When Vivid-to-Vivid messaging lands (see [Communication](06-communication.md)),
  the assignee becomes an address and this changes.
- Assignees are names, not accounts. People, teams, and projects are still product fixtures
  (see [Company and projects](12-company-and-projects.md)).
- The ticker is the same single-process demo adapter as the routine scheduler. Production needs a
  platform scheduler for the same reasons.

## What the references contributed

- **VCOS tasks** (`~/work/VCOS`, `packages/core/tasks`, `apps/web/src/server/tasks`): a shared
  org task list with agent-authored tasks, a required one-line reason, and tool descriptions that
  forbid filing work the agent could just do. Vivid keeps the tool discipline and the "created by
  agent" attribution, drops org tenancy and CRM links.
- **VCOS notifications** (`apps/web/src/db/schemas/notifications.ts`): a per-recipient feed with a
  seen/read state machine and producer idempotency. Vivid keeps a single-user read state and the
  one-notification-per-event rule (overdue is recorded once per task).
- **Garden automations** (`~/agency/garden/docs/features/automation-plan.md`): triggers own their
  runs and never route through another entity as orchestration. Follow-ups own their fires; they
  do not create routines or fake user messages.
- **Grok Bot** (`docs/06-communication.md`): asynchronous wake-on-delivery. The follow-up signal is
  Vivid waking itself; a message from another Vivid will use the same door.

## Surfaces

- **Today** in the sidebar is the home for this. Needs you (unread notifications), Overdue, Today,
  Waiting on others, Coming up (scheduled follow-ups), Later, and Done. The sidebar count is unread
  notifications plus overdue tasks.
- **Task detail** edits the task, lists follow-ups with edit, cancel, and run-now, adds a follow-up,
  and opens the task's conversation.
- **In the thread**, a compact card appears when Vivid creates a task or schedules a follow-up, so
  tracking is visible where it was agreed.
- **What Vivid did** (the log panel) labels task tool calls in plain language.

## API

All routes require the runtime bearer token.

```text
GET    /api/tasks                       tasks with their follow-ups
POST   /api/tasks                       { title, detail?, assignee?, dueAt?, priority?, followUp? }
PATCH  /api/tasks/:id                   { title?, detail?, assignee?, dueAt?, priority?, status? }
DELETE /api/tasks/:id
POST   /api/tasks/:id/nudge             run a follow-up now
POST   /api/tasks/:id/follow-ups        { at, note?, repeatEveryMs? }
PATCH  /api/follow-ups/:id              { at?, note?, repeatEveryMs?, status? }
DELETE /api/follow-ups/:id
POST   /api/follow-ups/:id/run
GET    /api/notifications               { notifications, unreadCount }
POST   /api/notifications/read          { ids? }  (all when omitted)
```

## Still to decide

- Whether an overdue task should keep chasing on a cadence after the first automatic follow-up.
- Whether Vivid may mark a task done on its own from a follow-up, or must always ask.
- How assignees become real people once membership exists, and whether a task assigned to a
  colleague appears in their Vivid.
- Quiet hours: when a follow-up should wait rather than wake.

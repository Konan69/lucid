## A reminder at a time

Send both files. The app stores the first chosen time before starting its workflow, so a retry with the same caller key reuses that time. `schedule` reads a scheduling receipt after an uncertain answer.

`migrations/0001_timers.sql`:

```sql
CREATE TABLE timer_arms (
  operation_key TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  words TEXT NOT NULL,
  run TEXT
);
```

`index.ts`:

```ts
import {
  defineApp,
  event,
  mutation,
  query,
  workflow,
  object,
  string,
  number,
  router,
  type MutationContext,
  type QueryContext,
  type WorkflowContext,
} from 'apps'

const due = event({
  description: 'A reminder came due.',
  payload: object({ text: string(), operationKey: string() }),
})
const requirements = { events: { 'reminder.due': due } }
type Arm = { at: number; words: string; run: string | null }

const ring = mutation(
  { input: object({ text: string(), operationKey: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) => {
    ctx.events.emit('reminder.due', input, { id: input.operationKey })
    return null
  },
)
const wait = workflow(
  { input: object({ text: string(), at: number(), operationKey: string() }) },
  async (ctx: WorkflowContext<typeof requirements>, input) => {
    await ctx.step.sleepUntil('until', input.at)
    await ctx.step.runMutation('ring', ring, {
      text: input.text,
      operationKey: input.operationKey,
    })
    return null
  },
)

// Save the first plan before dispatch; start's caller key deduplicates an interrupted retry.
const start = async (
  ctx: MutationContext<typeof requirements>,
  text: string,
  at: number,
  operationKey: string,
) => {
  const existing = ctx.sql
    .exec<Arm>('SELECT at, words, run FROM timer_arms WHERE operation_key = ?', operationKey)
    .toArray()[0]
  if (existing === undefined) {
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error('the time must be in the future')
    ctx.sql.exec(
      'INSERT INTO timer_arms (operation_key, at, words) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      operationKey,
      at,
      text,
    )
  }
  const arm = ctx.sql
    .exec<Arm>('SELECT at, words, run FROM timer_arms WHERE operation_key = ?', operationKey)
    .one()
  const run = await ctx.workflows.start({
    workflow: 'wait',
    input: { text: arm.words, at: arm.at, operationKey },
    key: operationKey,
  })
  if (run.status === 'errored' || run.status === 'terminated')
    throw new Error('the timer is not running')
  ctx.sql.exec('UPDATE timer_arms SET run = ? WHERE operation_key = ?', run.id, operationKey)
  return { operationKey, nextAt: arm.at }
}
const remindIn = mutation(
  { input: object({ text: string(), minutes: number(), operationKey: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) =>
    start(ctx, input.text, Date.now() + input.minutes * 60_000, input.operationKey),
)
const remindAt = mutation(
  { input: object({ text: string(), at: string(), operationKey: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) =>
    start(ctx, input.text, Date.parse(input.at), input.operationKey),
)
const schedule = query(
  { input: object({ operationKey: string() }) },
  async (ctx: QueryContext<typeof requirements>, input) => {
    const arm = ctx.sql
      .exec<Arm>(
        'SELECT at, words, run FROM timer_arms WHERE operation_key = ?',
        input.operationKey,
      )
      .toArray()[0]
    if (arm === undefined || arm.run === null) return { scheduled: false }
    const run = await ctx.workflows.get({ run: arm.run })
    if (run.status === 'errored' || run.status === 'terminated') return { scheduled: false }
    return { operationKey: input.operationKey, nextAt: arm.at }
  },
)

export default defineApp(requirements, {
  tools: router({ remindIn, remindAt, schedule, ring }),
  workflows: { wait },
})
```

1. Make the Integration once, then find its events.
2. `watch` `reminder.due` with `filters: {}` and Checkin purpose. Use Thread focus for "check on this", Owed for a named open obligation, or OpenWork for the owned backlog. Use Requested for explicit Person timing, including "in N minutes". Use Chosen only for an exact instant you select yourself, with its reason. Give a single requested reminder an explicit Until condition that ends after the requested check. A requested recurrence stays Continuous.
3. Read the operationKey returned in Awaiting. Arm with `use_tool`, copying that exact key into `operationKey`. For a requested relative delay, use remindIn, which reads the app's clock. For a clock time, remindAt takes an ISO date-time with the Person's offset. Arm a Chosen check with remindAt for its exact nextAt. remindIn would choose a different instant.
4. Read the actual `{ operationKey, nextAt }` receipt. The server confirms that Watch from this tool result. A lost or invalid answer leaves it Awaiting. Retry the same key or read `schedule` with it. Say it is scheduled only after confirmation, using the receipt's time.
5. On a still-open chosen check, `update_checkin` selects its next time and returns a new Awaiting key. Arm that key. An old key never names the updated check. Resolve the owed record when it arrives; the server reads that closure when the timer fires.

The timer emits `operationKey` in every payload. The server matches it to persisted intent, so leave subscription filters empty rather than embedding a key in them. Give each occurrence of a recurrence its own stable event id while retaining its arm's operationKey. Clock reads and randomness belong in mutations or workflow steps, not in the workflow body.

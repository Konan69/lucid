## A reminder at a time (a workflow that waits)

```ts
import {
  defineApp,
  event,
  mutation,
  workflow,
  object,
  string,
  number,
  router,
  type MutationContext,
  type WorkflowContext,
} from 'apps'

const due = event({
  description: 'A reminder came due.',
  filters: { list: string() },
  payload: object({ text: string() }),
})
const requirements = { events: { 'reminder.due': due } }

const ring = mutation(
  { input: object({ text: string(), key: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) => {
    ctx.events.emit(
      'reminder.due',
      { text: input.text },
      { filters: { list: 'default' }, id: input.key },
    )
    return null
  },
)

const wait = workflow(
  { input: object({ text: string(), at: number(), key: string() }) },
  async (ctx: WorkflowContext<typeof requirements>, input) => {
    await ctx.step.sleepUntil('until', input.at)
    await ctx.step.runMutation('ring', ring, { text: input.text, key: input.key })
    return null
  },
)

// Starts one waiting run; a past time is refused, because the run would never wake.
const start = async (ctx: MutationContext<typeof requirements>, text: string, at: number) => {
  if (Number.isNaN(at) || at <= Date.now()) throw new Error('the time must be in the future')
  const key = `reminder-${crypto.randomUUID()}`
  await ctx.workflows.start({ workflow: 'wait', input: { text, at, key }, key })
  return { at: new Date(at).toISOString() }
}

// "In 20 minutes": the app reads its own clock, so nobody has to know what time it is now.
const remindIn = mutation(
  { input: object({ text: string(), minutes: number() }) },
  async (ctx: MutationContext<typeof requirements>, input) =>
    start(ctx, input.text, Date.now() + input.minutes * 60_000),
)

// "Tomorrow at 9": an ISO date-time with the Person's offset.
const remindAt = mutation(
  { input: object({ text: string(), at: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) =>
    start(ctx, input.text, Date.parse(input.at)),
)

export default defineApp(requirements, {
  tools: router({ remindIn, remindAt, ring }),
  workflows: { wait },
})
```

Make it once, `watch` `reminder.due` once with an instruction such as "Tell the Person on their Feed: <the reminder's text>", then set each reminder with `use_tool`: remindIn with the minutes for anything said as "in N minutes or hours" (you do not know the current time, so never turn it into a clock time yourself), and remindAt with an ISO date-time **with the Person's offset** for a clock time on a date (for Lagos, `2026-10-17T09:00:00+01:00`). The answer is the time the app set: tell the Person that time. A mutation run by a workflow step must also be in the tools router. Put clock reads and randomness inside steps, never in the workflow body.

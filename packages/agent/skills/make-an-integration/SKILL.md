---
name: make-an-integration
description: |-
  When the Person wants something to happen later or on its own (a reminder at a time, something every morning, a page or feed checked for a change) and none of their Integrations already does it.
metadata:
  provenance: |-
    Adapted from Executor 2.0.0-beta.23's own app-authoring skill (packages/app-templates/executor/skills/app-authoring: SKILL.md, tools.md, events.md, workflows.md), for apps framework 0.0.1-beta.92. Vivid's names replace Executor's where they differ.
---

You make it yourself, as an Integration of your own: a small app whose source you write with `make_integration`. The app does one thing on its own (waits for a time, ticks on a schedule, checks something) and emits an **event** when it happens. You then `watch` that event with an instruction saying what to do, and each time it fires you wake in the background and put what matters on the Person's Feed with `post`. The app only says _that_ something happened; the watch instruction holds the work.

Agree the outcome first: what, when, in which time zone (ask with `ask_person` if you do not know it), and what the Person wants to see. Prefer one app per purpose, named for it ("Reminders", "Morning", "Price check"). Before making a new one, use `find_tools` to see whether one you made earlier already does it, and add to that instead of making a second.

## The source

Send only TypeScript files; Vivid adds `package.json` and pins the framework. `index.ts` has a default `defineApp(requirements, { tools, workflows?, schedules? })` export from `"apps"`. Tools are query (reads) and mutation (changes); both take `{ input: object({...}) }` and a handler `async (ctx, input) => result`. Return small JSON.

An event is declared in `requirements.events` and emitted from a mutation:

```ts
const due = event({
  description: 'A reminder came due.',
  filters: { list: string() },
  payload: object({ text: string() }),
})
const requirements = { events: { 'reminder.due': due } }
// inside a mutation:
ctx.events.emit('reminder.due', { text }, { filters: { list }, id: someStableId })
```

Event names are dotted lower-case words (`reminder.due`, `morning.started`). Filters are plain strings, numbers or booleans the watch can narrow on; when an event declares filters, every emit gives each one. An id that is stable for one occurrence keeps a retry from waking you twice. Emits from a handler that throws are discarded.

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

const remind = mutation(
  { input: object({ text: string(), at: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) => {
    const at = Date.parse(input.at)
    if (Number.isNaN(at)) throw new Error('at must be an ISO date-time with its offset')
    const key = `reminder-${at}-${input.text.slice(0, 40)}`
    await ctx.workflows.start({ workflow: 'wait', input: { text: input.text, at, key }, key })
    return { at: new Date(at).toISOString() }
  },
)

export default defineApp(requirements, { tools: router({ remind, ring }), workflows: { wait } })
```

Make it once, `watch` `reminder.due` once with an instruction such as "Tell the Person on their Feed: <the reminder's text>", then set each reminder by calling the app's remind tool with `use_tool` and an ISO date-time **with the Person's offset** (for Lagos, `2026-10-17T09:00:00+01:00`). A mutation run by a workflow step must also be in the tools router. Put clock reads and randomness inside steps, never in the workflow body.

## Something on a schedule

```ts
import {
  appCron,
  defineApp,
  event,
  mutation,
  object,
  router,
  string,
  type MutationContext,
} from 'apps'

const started = event({
  description: 'The morning began.',
  filters: {},
  payload: object({ day: string() }),
})
const requirements = { events: { 'morning.started': started } }

const tick = mutation(
  { input: object({}) },
  async (ctx: MutationContext<typeof requirements, 'app'>) => {
    const day = new Date().toISOString().slice(0, 10)
    ctx.events.emit('morning.started', { day }, { filters: {}, id: `morning-${day}` })
    return null
  },
)

export default defineApp(requirements, {
  tools: router({ tick }),
  schedules: {
    morning: appCron({ expression: '0 8 * * MON-FRI', timezone: 'Africa/Lagos' }, tick, {}),
  },
})
```

Use `appCron` (five-field cron, with an IANA time zone) or `appInterval` (`{ minutes: 30 }`, at least a minute). Its mutation's context is `MutationContext<typeof requirements, "app">` and it declares no approval: nobody is there to ask. Vivid turns app schedules on when it makes the app. Then `watch` the event with the work as its instruction ("Brief the Person on today's mail and meetings"); the work itself runs in your background Run with all your tools, so keep the app to the clock. To check a public page on a schedule, the mutation can fetch it and emit what it read; your watch instruction then compares it with what you remembered last time and posts only a real change.

## Make, fix, check

1. `make_integration` with the name and files. A failed build returns the compiler's message: fix that exact place and call again with the same name.
2. `find_events` with the new Integration's account name: the event must be listed. Then `watch` it with a name, the filters you need and the instruction.
3. For a reminder, call remind through `find_tools` and `use_tool`, and read back the time it answers.
4. Tell the Person in a sentence what will happen and when, in their time. Making and watching proves the setup, not that the first occurrence has happened; say so if they ask.

Never put a password, key or personal data in the source. An app that needs a provider's account is a different job: connect that provider instead.

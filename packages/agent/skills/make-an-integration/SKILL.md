---
name: make-an-integration
description: |-
  When the Person wants something to happen later or on its own (a reminder at a time, something every morning, a page or feed checked for a change), or wants a live display they can read and act on (a tracker, a list, a counter) that none of their Integrations already holds.
metadata:
  provenance: |-
    Adapted from Executor 2.0.0-beta.23's own app-authoring skill (packages/app-templates/executor/skills/app-authoring: SKILL.md, tools.md, events.md, workflows.md), for apps framework 0.0.1-beta.92. Vivid's names replace Executor's where they differ.
---

You make it yourself, as an Integration of your own: a small app whose source you write with `make_integration`. The app does one thing on its own (waits for a time, ticks on a schedule, checks something) and emits an **event** when it happens. You then `watch` that event with an instruction saying what to do, and each time it fires you wake in the background and put what matters on the Person's Feed with `post`. The app only says _that_ something happened; the watch instruction holds the work. An app that only holds data for a display (see `references/displays.md`) has tools and no event: skip the event, the watch and the timing questions.

Agree the outcome first: what, and for background work when and in which time zone (ask with `ask_person` if you do not know it), and what the Person wants to see. Prefer one app per purpose, named for it ("Reminders", "Morning", "Price check"). Before making a new one, use `find_tools` to see whether one you made earlier already has a tool that does it (a Reminders app's remindIn and remindAt set any number of reminders) and use that. Stop a Watch, including a reminder's Watch, by name with `stop_watching`. To change when a named check-in next runs, use `update_checkin`, then arm the timer Integration with the returned `operationKey` and read its actual receipt before saying it is scheduled. Read an Integration's source with `read_integration`, then use `revise` with its complete revised source files, preserving unrelated instructions, events and schedule settings. Read it back afterward before saying future runs changed.

## The source

Send TypeScript source and any app-owned SQL migrations the reference requires; Vivid adds `package.json` and pins the framework. `index.ts` has a default `defineApp(requirements, { tools, workflows?, schedules? })` export from `"apps"`. Tools are query (reads) and mutation (changes); both take `{ input: object({...}) }` and a handler `async (ctx, input) => result`. Return small JSON.

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

## Read only the reference the work needs

For a reminder at a time, read [references/reminders.md](references/reminders.md). For recurring work, read [references/schedules.md](references/schedules.md). For a display, read [references/displays.md](references/displays.md). Use `read_skill_file` with this skill's name and the relative file path.

## Make, fix, check

1. `make_integration` with the name and files. A failed build returns the compiler's message: fix that exact place and call again with the same name.
2. For background work, `find_events` with the new Integration's account name: the event must be listed. Then `watch` it with a name, the filters you need and the instruction.
3. For a timer-backed check-in, follow the reminder reference. Subscribe with Checkin purpose first, then arm with the persisted operationKey. Read the actual scheduling receipt before saying it is set. A lost answer stays Awaiting; read the receipt or retry the same key.
4. For a display app, call one query tool with `use_tool` and read back its answer before drawing the display.
5. Tell the Person in a sentence what will happen and when, in their time. Making and watching proves the setup, not that the first occurrence has happened; say so if they ask.

Never put a password, key or personal data in the source. An app that needs a provider's account is a different job: connect that provider instead.

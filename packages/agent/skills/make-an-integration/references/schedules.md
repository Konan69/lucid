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
    ctx.events.emit('morning.started', { day }, { id: `morning-${day}` })
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

Use `appCron` (five-field cron, with an IANA time zone) or `appInterval` (`{ minutes: 30 }`, at least a minute); never `userCron` or `userInterval`, which would run as Vivid's own Executor user and stay paused. An event with no filters is emitted with only its id. Its mutation's context is `MutationContext<typeof requirements, "app">` and it declares no approval: nobody is there to ask. Vivid turns app schedules on when it makes the app. Then `watch` the event with the work as its instruction ("Brief the Person on today's mail and meetings"); the work itself runs in your background Run with all your tools, so keep the app to the clock. To check a public page on a schedule, the mutation can fetch it and emit what it read; your watch instruction then compares it with what you remembered last time and posts only a real change.

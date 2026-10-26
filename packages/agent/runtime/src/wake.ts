import type { Wake } from '@earendil-works/pi-durable'
import { Context, Option } from 'effect'

/**
 * How a host that can be evicted is told when its Harness next needs a process (Pi 1.4.0
 * `HarnessOptions.onWake`). A Durable Object cell keeps its alarm armed from it and calls
 * `resume()` when the alarm fires (Pi README, "Durable sleeps", the `Session` example). The Node
 * process provides nothing: without `onWake` Pi's own timers keep the process awake and resume
 * sleeping tasks, which is right for a process that is never evicted.
 */
export const HarnessWake = Context.Reference<Option.Option<(wake: Wake) => void>>(
  'vivid/Runtime/HarnessWake',
  { defaultValue: () => Option.none() },
)

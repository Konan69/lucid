import { Effect } from 'effect'

import * as Holds from './holds.ts'
import * as Waiting from './waiting.ts'

/** Promise facade for callers outside Effect; the durable decision has one implementation. */
export const decide = (...args: Parameters<typeof Holds.decide>) =>
  Effect.runPromise(Holds.decide(...args))

/** Promise facade for person-supplied results, including idempotent late answers. */
export const answer = (...args: Parameters<typeof Holds.answer>) =>
  Effect.runPromise(Holds.answer(...args))

/** Promise facade for the derived durable waiting list. */
export const waiting = (...args: Parameters<typeof Waiting.waiting>) =>
  Effect.runPromise(Waiting.waiting(...args))

/** Temporary stage-2 hook facade; Pi's AbortSignal interrupts and removes the Deferred registration. */
export const settlement = (...args: Parameters<typeof Holds.settlement>) =>
  Effect.runPromise(Holds.settlement(...args), { signal: args[2].abortSignal })

export {
  ConversationMissing,
  PiFailed,
  TurnInvalid,
  RunMissing,
  ToolSchemaFailed,
} from './errors.ts'
export type { Answer, Decision, Settlement } from './holds.ts'
export type { Waiting } from './waiting.ts'
export type { Replay, ToolsOptions } from './tools.ts'
export type { RunInput } from './stream.ts'
export type { RunState } from './chunks.ts'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type Harness,
} from '@earendil-works/pi-durable'
import { PersonId, RunId, ThreadId } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import type { Acting } from './client.ts'
import { pi } from './threads.ts'

/**
 * Who a helper's conversation acts for, written in the commit that creates it (`children.ts`)
 * and never by the model. A helper's conversation belongs to no Thread of its own, so without
 * this record its tools would have nobody to act for (`authority.ts` `resolveCall`).
 */
interface HelperFacts {
  [key: string]: string
  threadId: string
  personId: string
  runId: string
  timezone: string
}

export const HelperAuthority = defineDocFamily<HelperFacts, HelperFacts>({
  kind: 'vivid.helper.authority',
  version: 1,
  scope: 'conversation',
  family: true,
  checkpointWhen: () => false,
  history: 'latest',
  fork: 'initial',
  initial: (facts) => facts,
})
export const HELPER_KEY = 'authority'

/**
 * A helper's tool budget: how many calls it may make and the ones already charged, by call id,
 * so a call Pi runs again after a restart is charged once. Absent, the limit is zero: a
 * conversation nobody budgeted makes no helper tool calls.
 */
export const HelperCalls = defineDoc<{ limit: number; counted: string[] }>({
  kind: 'vivid.helper.calls',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ limit: 0, counted: [] }),
})

const Facts = Schema.Struct({
  threadId: ThreadId,
  personId: PersonId,
  runId: RunId,
  timezone: Schema.String,
})
const decodeFacts = Schema.decodeUnknownOption(Facts)

/** A helper's acting Person, Thread and Run, for a conversation that is a helper's. */
export interface HelperScope {
  readonly acting: Acting
  readonly runId: RunId
  readonly timezone: string
}

/** The helper a conversation is, or nothing for a Thread's own conversation. */
export const helperOf: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<Option.Option<HelperScope>, import('./threads.ts').PiRejected> = Effect.fn(
  'Helper.of',
)(function* (harness: Harness, conversationId: ConversationId) {
  const facts = yield* pi(() =>
    harness.snapshot(HelperAuthority, conversationId, HELPER_KEY, BACKGROUND_CONTEXT),
  )
  if (facts === undefined) return Option.none()
  return Option.map(decodeFacts(facts), (decoded) => ({
    acting: { threadId: decoded.threadId, personId: decoded.personId },
    runId: decoded.runId,
    timezone: decoded.timezone,
  }))
})

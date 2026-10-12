import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import type { RpcGroup } from 'effect/rpc'
import { VividRpc } from '@vivid/contracts/rpc'
import { Message } from '../observability/messages.ts'
import { untraced } from '../observability/quiet.ts'

/**
 * What a live query is counted under: the `Watch…` call it serves, or one of the two reads every
 * subscription makes for itself. `Actor` is the session read that decides who a subscription is
 * for (`live/query.ts` `live`); `Session` is the read that ends a stream when its session does.
 */
export type Watched =
  | Extract<RpcGroup.Rpcs<typeof VividRpc>['_tag'], `Watch${string}`>
  | 'Actor'
  | 'Session'

/** Every name a count can carry, for the export allowlist: the contract's `Watch…` tags and ours. */
export const watchedNames: ReadonlyArray<string> = [
  ...[...VividRpc.requests.keys()].filter((tag) => tag.startsWith('Watch')),
  'Actor',
  'Session',
]

/** Whose data a change notification said had moved. `everything` is the listener reconnecting. */
export type Moved = 'person' | 'company' | 'thread' | 'everything'

/** The attributes of one query's line. Each is a whole number; times are milliseconds. */
export const LiveAttribute = {
  query: 'vivid.live.query',
  /** Subscriptions open when the line was written. The only value that is not a count since the last line. */
  open: 'vivid.live.open',
  /** Loads that ran to an answer. */
  loads: 'vivid.live.loads',
  /** Answers that differed from the one before and were sent to the client. */
  sent: 'vivid.live.sent',
  /**
   * Loads stopped before they answered: a newer change arrived first, or the subscription ended
   * (the client left, its session ran out, the server is stopping). The two are not told apart.
   */
  interrupted: 'vivid.live.interrupted',
  /** Loads that failed, which ends their subscription. */
  failed: 'vivid.live.failed',
  /** Time spent in the loads that answered, added up. */
  loadMillis: 'vivid.live.load_ms',
  /** The longest single load that answered. */
  slowestMillis: 'vivid.live.slowest_ms',
} as const

/**
 * The attributes of the change bus's line: how many notifications named each kind of owner. A
 * notification that names three People is one for `person`, not three.
 */
export const MovedAttribute = {
  person: 'vivid.changes.person',
  company: 'vivid.changes.company',
  thread: 'vivid.changes.thread',
  everything: 'vivid.changes.everything',
} as const satisfies Record<Moved, string>

interface Counts {
  open: number
  loads: number
  sent: number
  interrupted: number
  failed: number
  loadMillis: number
  slowestMillis: number
}

const fresh = (open: number): Counts => ({
  open,
  loads: 0,
  sent: 0,
  interrupted: 0,
  failed: 0,
  loadMillis: 0,
  slowestMillis: 0,
})

const still = (): Record<Moved, number> => ({ person: 0, company: 0, thread: 0, everything: 0 })

/** What one report holds: a line for each query that did anything, and the bus's counts. */
export interface Report {
  readonly queries: ReadonlyArray<readonly [Watched, Readonly<Counts>]>
  readonly moved: Readonly<Record<Moved, number>>
}

/**
 * The counts of what the live queries of this process did since they were last read.
 *
 * A reload is deliberately not traced (`observability/quiet.ts`): one Person with the app open
 * exported 47,000 spans an hour that way. That left nothing saying how often each query runs, how
 * long it takes, or how many of its answers are thrown away for being the same as the last. Those
 * are the numbers that decide whether a change topic is too wide, so they are counted here and
 * written as one line a minute for each query that did anything (`tallyLayer`).
 *
 * The counts are plain numbers changed in place. Every update is synchronous and JavaScript runs
 * one at a time, so there is nothing to lock.
 */
export interface Tally {
  readonly opened: (name: Watched) => void
  readonly closed: (name: Watched) => void
  readonly loaded: (name: Watched, millis: number, exit: Exit.Exit<unknown, unknown>) => void
  readonly sent: (name: Watched) => void
  readonly moved: (kind: Moved) => void
  /** Reads the counts and starts them again. A query with nothing open and nothing counted is left out. */
  readonly drain: () => Report
}

export const makeTally = (): Tally => {
  const queries = new Map<Watched, Counts>()
  let moved = still()
  const of = (name: Watched) => {
    const found = queries.get(name)
    if (found !== undefined) return found
    const made = fresh(0)
    queries.set(name, made)
    return made
  }
  return {
    opened: (name) => {
      of(name).open += 1
    },
    closed: (name) => {
      of(name).open -= 1
    },
    loaded: (name, millis, exit) => {
      const counts = of(name)
      if (Exit.isSuccess(exit)) {
        counts.loads += 1
        counts.loadMillis += millis
        counts.slowestMillis = Math.max(counts.slowestMillis, millis)
      } else if (Exit.hasInterrupts(exit)) counts.interrupted += 1
      else counts.failed += 1
    },
    sent: (name) => {
      of(name).sent += 1
    },
    moved: (kind) => {
      moved[kind] += 1
    },
    drain: () => {
      const report = {
        queries: [...queries].filter(
          ([, counts]) => counts.loads + counts.interrupted + counts.failed + counts.sent > 0,
        ),
        moved,
      }
      for (const [name, counts] of queries) {
        if (counts.open === 0) queries.delete(name)
        else queries.set(name, fresh(counts.open))
      }
      moved = still()
      return report
    },
  }
}

/**
 * The tally the live queries write to. It is a reference with a value of its own, not a service a
 * Layer must supply, because counting is not something a test of a query should have to arrange:
 * a program that provides nothing counts into the process's one tally and nobody reads it.
 */
export const LiveTally = Context.Reference<Tally>('vivid/LiveTally', { defaultValue: makeTally })

const REPORT_EVERY = '1 minute'

/** Writes what was counted, one line for each query and one for the bus, and nothing when idle. */
export const report = Effect.fn('LiveTally.report')(function* () {
  const { queries, moved } = (yield* LiveTally).drain()
  yield* Effect.forEach(
    queries,
    ([name, counts]) =>
      Effect.annotateLogs(Effect.logInfo(Message.live), {
        [LiveAttribute.query]: name,
        [LiveAttribute.open]: counts.open,
        [LiveAttribute.loads]: counts.loads,
        [LiveAttribute.sent]: counts.sent,
        [LiveAttribute.interrupted]: counts.interrupted,
        [LiveAttribute.failed]: counts.failed,
        [LiveAttribute.loadMillis]: counts.loadMillis,
        [LiveAttribute.slowestMillis]: counts.slowestMillis,
      }),
    { discard: true },
  )
  if (moved.person + moved.company + moved.thread + moved.everything > 0)
    yield* Effect.annotateLogs(Effect.logInfo(Message.moved), {
      [MovedAttribute.person]: moved.person,
      [MovedAttribute.company]: moved.company,
      [MovedAttribute.thread]: moved.thread,
      [MovedAttribute.everything]: moved.everything,
    })
})

/** Reports once a minute for the life of the server. An idle server writes no line. */
export const tallyLayer = Layer.effectDiscard(
  report().pipe(untraced, Effect.repeat(Schedule.spaced(REPORT_EVERY)), Effect.forkScoped),
)

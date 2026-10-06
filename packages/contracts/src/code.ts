import * as Schema from 'effect/Schema'
import { ACCOUNT_HANDLE_MAX } from './connections.js'
import { ApprovalId } from './identity.js'

/**
 * One timing contract keeps the server deadline, the waits that follow it and the client timeout
 * in order. After the deadline the server waits `graceMs` for what the program printed, then at
 * most `stopMs` for its order to stop to reach the Computer and `endMs` for word that the program
 * is over. Nothing else may be waited for before the outcome is returned.
 */
export const CodeTiming = {
  seconds: 300,
  graceMs: 1_000,
  stopMs: 4_000,
  endMs: 3_000,
} as const
/**
 * The program tool's own timeout: the server deadline, every wait that can follow it, and a
 * margin for the answer's way back. It is the only client-side bound: the runtime's HTTP client
 * already waits an hour for headers and has no body timeout (`@effect/platform-node`
 * `NodeHttpClient.ts`, `makeUndici`), so the transport never gives up before this does.
 */
export const CodeToolTimeout =
  CodeTiming.seconds * 1_000 + CodeTiming.graceMs + CodeTiming.stopMs + CodeTiming.endMs + 3_000

/** Discovery and guest dispatch accept exactly the same account/tool vocabulary. */
export const CodeToolNames = Schema.Struct({
  account: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(ACCOUNT_HANDLE_MAX)),
  tool: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})

/**
 * A program Vivid writes to do several things in one go.
 *
 * Asking for one tool at a time costs a round trip through the model for every step, and every
 * intermediate result passes through its context. A program calls the same tools Vivid already
 * has (the Person's Connections, their Computer), keeps what it reads to itself, and answers with
 * only what it chose to return. It is JavaScript run on the Person's Computer. It holds no
 * credentials and names nothing by identifier: each call it makes is checked on the server, as the
 * Person the Run is for, exactly as if Vivid had asked for it alone. What a program sees (`tools`,
 * `accounts`, an async function body) follows the code mode of the pi coding agent and of Executor.
 */
export const RunCodeRequest = Schema.Struct({
  code: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
  /** One sentence saying what the program is for, shown in the Thread. */
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})
export interface RunCodeRequest extends Schema.Schema.Type<typeof RunCodeRequest> {}

/** The tools a program can call. A closed list: a program cannot reach anything else. */
export const CodeCallKind = Schema.Literals([
  'find_tools',
  'use_tool',
  'run_command',
  'browse',
  'read_page',
] as const)
export type CodeCallKind = typeof CodeCallKind.Type

/** How one call the program made ended. A call that needed a decision ended the program. */
export const CodeCallEnd = Schema.Literals([
  'completed',
  'refused',
  'needs approval',
  'unknown',
] as const)
export type CodeCallEnd = typeof CodeCallEnd.Type

/** One call the program made, as the Thread shows it: what it was for and how it ended. */
export const CodeCall = Schema.Struct({
  kind: CodeCallKind,
  summary: Schema.String,
  end: CodeCallEnd,
}).annotate({ identifier: 'CodeCall', title: 'Code call' })
export interface CodeCall extends Schema.Schema.Type<typeof CodeCall> {}

/** Why a program did not run to its end. Each is handled differently, so each has its own tag. */
export const CodeFailure = Schema.TaggedUnion({
  /** The program is not valid JavaScript, or threw. `message` is the error's own, bounded. */
  Threw: { message: Schema.String },
  TimedOut: { seconds: Schema.Number },
  /** It used more memory, made more calls or returned more than a program may. */
  OverLimit: { limit: Schema.Literals(['memory', 'calls', 'data', 'result'] as const) },
  /** The Person's Computer could not run the program, or stopped carrying it: it did not start,
   * the Person is using it, or its provider stopped answering. When no call is listed, nothing
   * was done for the Person; the program itself may have run for a while on the Computer. */
  Unavailable: {},
})
export type CodeFailure = typeof CodeFailure.Type

/** Printed lines survive success and failure separately from the returned JSON value. */
export const CodeLogs = Schema.Struct({
  logs: Schema.Array(Schema.String),
  logsTruncated: Schema.Boolean,
})
export interface CodeLogs extends Schema.Schema.Type<typeof CodeLogs> {}

/**
 * What came of a program. Calls that completed before it stopped stay completed: nothing is rolled
 * back and nothing is run again, so every outcome carries the calls that were made.
 */
export const CodeOutcome = Schema.TaggedUnion({
  Completed: {
    result: Schema.Json,
    calls: Schema.Array(CodeCall),
    truncated: Schema.Boolean,
    ...CodeLogs.fields,
  },
  /** One call needs a Person's decision. The program has ended; the approved action runs alone. */
  ApprovalRequired: {
    approvalId: ApprovalId,
    summary: Schema.String,
    calls: Schema.Array(CodeCall),
  },
  Blocked: { rule: Schema.String, calls: Schema.Array(CodeCall) },
  Failed: { failure: CodeFailure, calls: Schema.Array(CodeCall), ...CodeLogs.fields },
  /** A call that changes something was sent and its answer was lost. Never retried. */
  OutcomeUnknown: { calls: Schema.Array(CodeCall) },
})
export type CodeOutcome = typeof CodeOutcome.Type

/** Reading one public page without a Computer: the address in, its readable text out. */
export const ReadPageRequest = Schema.Struct({
  address: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4000)),
})
export interface ReadPageRequest extends Schema.Schema.Type<typeof ReadPageRequest> {}

/** Why a page could not be read. */
export const ReadPageRefusal = Schema.Literals([
  'not a public web address',
  'could not be reached',
  'not a readable page',
] as const)
export type ReadPageRefusal = typeof ReadPageRefusal.Type

export const ReadPageOutcome = Schema.TaggedUnion({
  Read: {
    /** Where the page really was, after any redirects. */
    address: Schema.String,
    title: Schema.String,
    /** The page as readable text: headings, paragraphs, lists and links, no markup. */
    text: Schema.String,
    truncated: Schema.Boolean,
  },
  Refused: { reason: ReadPageRefusal },
})
export type ReadPageOutcome = typeof ReadPageOutcome.Type

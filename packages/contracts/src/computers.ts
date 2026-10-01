import { Schema } from 'effect'
import { ApprovalId, ComputerId } from './identity.js'

/**
 * Where a Person's Computer stands. A Computer is created the first time it is needed and stopped
 * when idle; its files and sign-ins outlive the machine that held them.
 */
export const ComputerState = Schema.TaggedUnion({
  /** This Person has never needed one. */
  Absent: {},
  Starting: { since: Schema.Number },
  Running: { since: Schema.Number, screenAddress: Schema.String },
  Stopped: { since: Schema.Number },
  Failed: { since: Schema.Number, reason: Schema.String },
  /** No machine provider is configured on this installation. */
  Unavailable: {},
})
export type ComputerState = typeof ComputerState.Type

export const Computer = Schema.Struct({
  id: Schema.NullOr(ComputerId),
  state: ComputerState,
  /** Whether a Person, rather than Vivid, currently holds the keyboard and pointer. */
  heldByPerson: Schema.Boolean,
}).annotate({ identifier: 'Computer', title: 'Computer' })
export interface Computer extends Schema.Schema.Type<typeof Computer> {}

export const ComputerResponse = Schema.Struct({ computer: Computer })

/** One command Vivid runs on the Computer. */
export const RunCommandRequest = Schema.Struct({
  command: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
  /** One sentence saying what this does, shown if a Person must approve it. */
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  timeoutSeconds: Schema.optionalKey(Schema.Number),
})
export interface RunCommandRequest extends Schema.Schema.Type<typeof RunCommandRequest> {}

/** What the command produced. Long output is cut with a marker, never silently. */
export const CommandResult = Schema.Struct({
  exitCode: Schema.Number,
  output: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: 'CommandResult', title: 'Command result' })
export interface CommandResult extends Schema.Schema.Type<typeof CommandResult> {}

/** One thing Vivid does in the Computer's browser. */
export const BrowserAction = Schema.TaggedUnion({
  Open: { address: Schema.String },
  Read: {},
  Click: { target: Schema.String },
  Type: { target: Schema.String, text: Schema.String },
  Press: { key: Schema.String },
  Screenshot: {},
})
export type BrowserAction = typeof BrowserAction.Type

export const BrowseRequest = Schema.Struct({
  action: BrowserAction,
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})
export interface BrowseRequest extends Schema.Schema.Type<typeof BrowseRequest> {}

/** What the page looks like after the action: its address, title and readable outline. */
export const BrowseResult = Schema.Struct({
  address: Schema.String,
  title: Schema.String,
  outline: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: 'BrowseResult', title: 'Browse result' })
export interface BrowseResult extends Schema.Schema.Type<typeof BrowseResult> {}

/** What came of a command: its result, a decision to wait for, a rule that forbids it, or no machine. */
export const CommandOutcome = Schema.TaggedUnion({
  Completed: { result: CommandResult },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String },
  /** A Person holds the Computer, or it is not running and could not be started. */
  Unavailable: { reason: Schema.String },
})
export type CommandOutcome = typeof CommandOutcome.Type

/** What came of a browser step, with the same four possibilities. */
export const BrowseOutcome = Schema.TaggedUnion({
  Completed: { result: BrowseResult },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String },
  Unavailable: { reason: Schema.String },
})
export type BrowseOutcome = typeof BrowseOutcome.Type

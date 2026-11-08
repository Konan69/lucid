import { VividRpcClient } from '@vivid/client-runtime'
import {
  CodeFailure,
  CodeOutcome,
  DisplayProgramWaiting,
  RunCodeRequest,
  ToolOutcome,
  type DisplayCodeOutcome,
  type DisplaySource,
} from '@vivid/contracts'
import { Effect, Match, Option, Predicate, Result, Schedule, Schema } from 'effect'

/**
 * How a reply splits into words and displays lives with the contracts, because the server reads a
 * stored reply's programs with the same reading the surfaces draw it with.
 */
export { stretches, type Stretch } from '@vivid/contracts/display'

/** One field of a form as OpenUI's renderer keeps it: the value typed, picked or ticked. */
const Field = Schema.Struct({
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
})
const readForm = Schema.decodeUnknownOption(Schema.Record(Schema.String, Field))

/** Everything a display's forms hold when a Button is pressed, keyed as OpenUI's renderer keys it. */
export const FormState = Schema.Record(Schema.String, Schema.Unknown)
export type FormState = typeof FormState.Type

/** A ticked box reads as a word; an empty or unticked field says nothing. */
function fieldWords(value: string | number | boolean): Option.Option<string> {
  if (Predicate.isBoolean(value)) return value ? Option.some('yes') : Option.none()
  const typed = String(value).trim()
  return typed === '' ? Option.none() : Option.some(typed)
}

/**
 * What the Person's press says in the Thread: the Button's own words, then each filled field of the
 * form it sat in as a readable line, in the form's order. The renderer keeps `$variables` beside
 * the forms under names that start with `$`; a display already writes those into the Button's
 * words, so they are left out here.
 */
export function said(pressed: string, formState: FormState): string {
  const lines = Object.entries(formState)
    .filter(([name]) => !name.startsWith('$'))
    .flatMap(([, form]) =>
      Option.match(readForm(form), {
        onNone: () => [],
        onSome: (fields) => Object.entries(fields),
      }),
    )
    .flatMap(([name, field]) =>
      Option.match(fieldWords(field.value), {
        onNone: () => [],
        onSome: (value) => [`${name}: ${value}`],
      }),
    )
  return [pressed, ...lines].join('\n')
}

/** One node of a statement as OpenUI's parser reports it: a literal carries `v`, an object `entries`. */
interface Written {
  readonly k: string
  readonly v?: unknown
}

/** A Query or Mutation's name and arguments, as OpenUI's parser reports them. */
interface WritingStatement {
  readonly toolAST: Written | null
  readonly argsAST: {
    readonly k: string
    readonly entries?: ReadonlyArray<readonly [string, Written]>
  } | null
}

/**
 * The tool names one kind of declaration can call. OpenUI evaluates a name written as an
 * expression only when it calls, so such a name could be any tool and `computed` says it may be.
 */
interface Declared {
  readonly names: ReadonlySet<string>
  readonly computed: boolean
}

const declared = (statements: ReadonlyArray<WritingStatement>): Declared => ({
  names: new Set(
    statements.flatMap((statement) =>
      statement.toolAST !== null &&
      statement.toolAST.k === 'Str' &&
      Predicate.isString(statement.toolAST.v)
        ? [statement.toolAST.v]
        : [],
    ),
  ),
  computed: statements.some(
    (statement) =>
      statement.toolAST === null ||
      statement.toolAST.k !== 'Str' ||
      !Predicate.isString(statement.toolAST.v),
  ),
})

/**
 * What a display's `Query` and `Mutation` declarations can call. OpenUI's renderer calls the one
 * provider with only a name for both (`fetchQuery` and `fireMutation` in lang-core's
 * `index.mjs`), so the surface derives a call's intent from these declarations.
 */
export interface DisplayTools {
  readonly queries: Declared
  readonly mutations: Declared
  /** Whether a Query may run a program the display does not write out (`writesProgram`). */
  readonly unwrittenQueryProgram: boolean
}

/**
 * Whether a `run_code` declaration writes its program out as `{code: "...", summary: "..."}`, both
 * plain strings and nothing else: the only shape the server counts as a stored declaration
 * (`literalProgram` in `apps/server/src/code/source.ts`). Such a Query can only ever send that
 * one program; any other may send whatever its expressions evaluate to when it calls.
 */
const writesProgram = ({ argsAST }: WritingStatement) => {
  if (argsAST === null || argsAST.k !== 'Obj' || argsAST.entries === undefined) return false
  const entries = argsAST.entries
  return (
    entries.length === 2 &&
    ['code', 'summary'].every((field) =>
      entries.some(([name, node]) => name === field && Predicate.isString(node.v)),
    )
  )
}

export const displayTools = (parsed: {
  readonly mutationStatements: ReadonlyArray<WritingStatement>
  readonly queryStatements: ReadonlyArray<WritingStatement>
}): DisplayTools => {
  const queries = declared(parsed.queryStatements)
  return {
    queries,
    mutations: declared(parsed.mutationStatements),
    unwrittenQueryProgram:
      queries.computed ||
      parsed.queryStatements.some(
        (statement) =>
          statement.toolAST !== null &&
          statement.toolAST.v === 'run_code' &&
          !writesProgram(statement),
      ),
  }
}

const mayCall = (from: Declared, name: string): boolean => from.computed || from.names.has(name)

/**
 * What OpenUI's renderer reads back from a tool: MCP's shape, which it unwraps itself. Its
 * `content` is a plain array because OpenUI's `McpClientLike` declares it so.
 */
export interface DisplayToolResult {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

const failed = (text: string): DisplayToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

/**
 * The server's answer to a display's call, as the renderer reads it. Only a completed call has
 * data; every other outcome reaches OpenUI's error API and a Mutation's `result.error`.
 */
export const displayToolResult = (outcome: ToolOutcome): DisplayToolResult =>
  ToolOutcome.match(outcome, {
    Completed: ({ output }) => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    }),
    Rejected: () =>
      failed('The Integration rejected this request. Check the information and try again.'),
    Blocked: () => failed('A rule prevents this action.'),
    ApprovalRequired: () => failed('This needs your approval in the Thread.'),
    ScopeRequired: () =>
      failed(
        'This Integration needs more access. Reconnect it in Settings and allow what Vivid asks for.',
      ),
    PermissionDeclined: () =>
      failed('You have not allowed Vivid to use this kind of information from this Integration.'),
    Unsupported: () => failed('This Integration cannot do that yet.'),
    // The server only answers this way for Vivid's journaled calls; a display's own call is never
    // one, so this says plainly that nothing new happened.
    Repeated: () => failed('This was already done, so it was not done again.'),
    ConnectionNotReady: () => failed('This Integration needs to be connected again.'),
    OutcomeUnknown: () => failed('No answer came back. It may or may not have happened.'),
  })

const decodeJson = Schema.decodeUnknownEffect(Schema.Json)
const decodeProgram = Schema.decodeUnknownEffect(RunCodeRequest)

/**
 * A Query that may run a program the display does not write out, beside a Mutation that runs one:
 * the Query could send the Mutation's program with no press, and the server, which reads a
 * program's kind from where the display writes it, would run it as the Mutation.
 */
export class DisplayProgramAmbiguous extends Schema.TaggedError<DisplayProgramAmbiguous>()(
  'DisplayProgramAmbiguous',
  {},
  { title: 'Display program intent is ambiguous' },
) {}

/** The same refusal for an Integration's tool, which a Query must never run with a press's authority. */
export class DisplayToolAmbiguous extends Schema.TaggedError<DisplayToolAmbiguous>()(
  'DisplayToolAmbiguous',
  {},
  { title: 'Display tool intent is ambiguous' },
) {}

/** Program errors may contain input or credentials; only their typed category reaches the reader. */
const programFailure = (failure: CodeFailure): string =>
  CodeFailure.match(failure, {
    Threw: () => 'The program failed. Ask Vivid to fix it.',
    TimedOut: () => 'The program took too long and was stopped.',
    OverLimit: ({ limit }) =>
      `The program exceeded its ${limit} limit. Ask Vivid to do less at once.`,
    Unavailable: () => 'Your Computer is unavailable. Open it and try again.',
    Busy: ({ message }) => message,
  })

const isWaiting = Schema.is(DisplayProgramWaiting)

/**
 * The server's wait: the reply this display came from is not yet settled in conversation history. It is
 * an error to OpenUI, never data: OpenUI keeps an error without settled data and asks again the
 * next time it reads the display's Queries (`evaluateQueries`, lang-core 1.0.0), so the display
 * runs its program once the reply has settled instead of keeping this wait as its answer. The
 * surfaces also hold OpenUI (`arriving`) until the reply's submission is settled, so this only
 * comes when the server's history is behind what the surface saw.
 */
const waiting = (): DisplayToolResult => failed('Vivid is still finishing this reply.')

/**
 * The program's return value is the display's data; logs and execution receipts stay separate.
 *
 * Only a completed program is data. Every other answer, the server's wait included, ran nothing or
 * did not finish (Waiting, Busy, a failure), so it is an error: OpenUI keeps a
 * Query's error without settled data and asks again the next time it reads the display's Queries
 * (`evaluateQueries` asks for any Query whose cache entry has no data, lang-core 1.0.0).
 */
export const displayCodeResult = (outcome: DisplayCodeOutcome): DisplayToolResult =>
  isWaiting(outcome)
    ? waiting()
    : CodeOutcome.match(outcome, {
        Completed: ({ result }) =>
          displayToolResult(ToolOutcome.cases.Completed.make({ output: result, receipt: null })),
        ApprovalRequired: () => failed('This needs your approval in the Thread.'),
        Blocked: () => failed('A rule prevents this action.'),
        Failed: ({ failure }) => failed(programFailure(failure)),
        OutcomeUnknown: () => failed('No answer came back. It may or may not have happened.'),
      })

/**
 * Whether a call came from a `Query` or a `Mutation`. For an Integration's tool the server takes
 * this answer, so a name both kinds can call is refused: answering it as a Query could run a
 * press's write automatically. A name only a Mutation can call is one; anything else runs as a
 * Query, the lesser authority.
 *
 * A program's kind is the server's to read, from the declaration in the stored display whose
 * code and summary it is (`CodeSource` in `apps/server/src/code/source.ts`), and the kind sent
 * with it is only a hint the server does not use. So a display may run programs both ways, each
 * written out; the server refuses one whose code is written as both. The server also refuses every
 * program from a stored reply whose displays declare a computed name or program (`declarations`
 * in `source.ts`), so the refusal kept here (`DisplayProgramAmbiguous`, a Mutation beside a Query
 * whose program is not written out) is the same conservative policy applied before asking, not a
 * case only the client can catch. It changes no behaviour.
 */
const callKind = Effect.fn('Display.callKind')(function* (name: string, tools: DisplayTools) {
  const mutates = mayCall(tools.mutations, name)
  const queries = mayCall(tools.queries, name)
  if (name === 'run_code') {
    if (mutates && tools.unwrittenQueryProgram) return yield* new DisplayProgramAmbiguous({})
    return mutates && !queries ? ('Mutation' as const) : ('Query' as const)
  }
  if (mutates && queries) return yield* new DisplayToolAmbiguous({})
  return mutates ? ('Mutation' as const) : ('Query' as const)
})

/**
 * How a program is asked again while the server waits for the reply it was drawn from to settle.
 * The surfaces already hold a display until its reply is settled, so a wait means the server's
 * history is a moment behind; OpenUI does not ask an errored Query again by itself (its query
 * effect only re-runs when the program, form state or streaming flag changes, lang-core 1.0.0), so
 * without this the display would keep the wait. Six more asks over about half a minute, then the
 * wait is the answer and a redraw or `@Run` asks again. Nothing cancels them when the display leaves
 * the screen (the surfaces' `run` is not interrupted and OpenUI drops a late answer), so the budget
 * is what bounds an abandoned call.
 */
const WAITING_AGAIN = Schedule.max([Schedule.exponential('500 millis'), Schedule.recurs(6)])

/**
 * One call a display makes into the Person's Integrations or onto their Computer, as OpenUI's
 * renderer asks for it. The server runs it for the Person, in the display's own Thread. A program
 * names the stored content it was drawn from (`source`), so the server runs only program text it
 * finds there, never text the reader supplied.
 */
export const callDisplayTool = Effect.fn('Display.callTool')(function* (
  name: string,
  given: Option.Option<FormState>,
  tools: DisplayTools,
  source: DisplaySource,
) {
  const client = yield* VividRpcClient
  const kind = yield* callKind(name, tools)
  if (name === 'run_code') {
    const request = yield* decodeProgram(
      Option.getOrElse(given, () => ({})),
      {
        onExcessProperty: 'error',
      },
    )
    const outcome = yield* client
      .RunDisplayCode({ ...request, source, kind })
      .pipe(Effect.repeat({ while: isWaiting, schedule: WAITING_AGAIN }))
    return displayCodeResult(outcome)
  }
  const input = yield* decodeJson(Option.getOrElse(given, () => ({})))
  return displayToolResult((yield* client.UseDisplayTool({ name, input, kind })).outcome)
})

/** A closed failure vocabulary preserves server refusals instead of replacing them with transport copy. */
type DisplayToolFailure = Effect.Error<ReturnType<typeof callDisplayTool>>
const displayFailure = Match.type<DisplayToolFailure>().pipe(
  Match.tagsExhaustive({
    DisplayApprovalUnsupported: () =>
      'This Integration needs an approval Vivid cannot provide yet.',
    DisplayProgramAmbiguous: () =>
      'This display mixes automatic programs with button actions. Ask Vivid to use separate displays.',
    DisplayProgramRefused: ({ message }) => message,
    DisplayToolAmbiguous: () =>
      'This display uses the same Integration action automatically and from a button. Ask Vivid to use separate displays.',
    SchemaError: () => 'This display sent invalid information. Ask Vivid to fix it.',
    NotFound: () => 'This Thread or Integration is no longer available to you.',
    Forbidden: () => 'You do not have permission to run this display.',
    Unauthenticated: () => 'Sign in again to use this display.',
    Conflict: () => 'The Integration changed. Refresh this display and try again.',
    ConversationTooLarge: () => 'This conversation is too large to open. Start a new Thread.',
    InvalidRequest: () => 'This display sent a request Vivid could not accept.',
    RuntimeUnavailable: () => 'Vivid is unavailable. Try again shortly.',
    ServiceUnavailable: ({ service }) =>
      ({
        computer: 'Your Computer is unavailable. Open it and try again.',
        connections: 'The Integration is unavailable. Try again shortly.',
        memory: 'Vivid could not read its memory. Try again shortly.',
      })[service],
    DatabaseUnavailable: () => 'Vivid could not read the saved information. Try again shortly.',
    DatabaseFailure: () => 'Vivid could not read the saved information. Try again shortly.',
    DatabaseConstraintViolation: () => 'The saved information changed. Refresh and try again.',
    // A lost RPC reply does not prove a Mutation failed; never encourage a duplicate action.
    RpcClientError: () =>
      'No reply came back from Vivid. The action may have completed. Check before trying again.',
  }),
)

/** MCP errors enter OpenUI's Query/Mutation `.error` and Renderer.onError, without exposing raw failures. */
export const displayToolAnswer = (
  answered: Result.Result<DisplayToolResult, DisplayToolFailure>,
): DisplayToolResult =>
  Result.match(answered, {
    onSuccess: (result) => result,
    onFailure: (failure) => failed(displayFailure(failure)),
  })

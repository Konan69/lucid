import { VividRpcClient } from '@vivid/client-runtime'
import { ToolOutcome } from '@vivid/contracts'
import { Effect, Option, Predicate, Result, Schema } from 'effect'

/**
 * A display is part of Vivid's reply: a short program in OpenUI Lang. Each surface draws it with
 * OpenUI's renderer and its own parts, in place, while the reply is still arriving. Nothing is
 * fetched and there is no second copy: the reply is the record.
 *
 * A reply holds a program the ways OpenUI itself recognises one (`isUIOutput` and `stripFences` in
 * thesysdev/openui `packages/server/src/shared/utils.ts` and `packages/lang-core/src/parser/
 * parser.ts`): a fence tagged `openui-lang` or `openui`, a fence with no tag whose body is a
 * program (`root = ...`), or a bare program starting `root =` on its own line. The prompt asks for
 * the first; a model that writes one of the others still gets a display drawn, never its source.
 */
/** A fence line; its tag is the first word of whatever follows the backticks. */
const FENCE = /^```[ \t]*([^`\s]*)[^`\n]*$/u
const CLOSE = /^```[ \t]*$/u
const TAGS: ReadonlySet<string> = new Set(['openui-lang', 'openui'])
/** A program's first statement. Upstream's `ROOT_ASSIGN` allows leading space, and so does this. */
const ROOT = /^\s*root\s*=(?!=)/u
/** One statement of a program: `name = ...` or `$name = ...`, never a comparison. */
const STATEMENT = /^\s*\$?[A-Za-z_]\w*\s*=(?!=)/u
/** A line that carries on the expression above it, such as the branches of a ternary. */
const OPERATOR = /^\s*(?:[?:]|&&|\|\|)/u
/** A comment line, which OpenUI's parser drops (`stripComments` in lang-core's `parser.ts`). */
const COMMENT = /^\s*(?:\/\/|#)/u

/** A stretch of a reply, in order: words to read, or a display to draw. */
export type Stretch =
  | { readonly kind: 'words'; readonly from: number; readonly text: string }
  | {
      readonly kind: 'display'
      readonly from: number
      readonly text: string
      /** Whether its end has arrived. Until then the renderer draws what it has. */
      readonly whole: boolean
    }

/** A fence line the reply is in the middle of writing, which is not words to show yet. */
const OPENING = /(?:^|\n)`{1,3}[a-z-]*$/u

/** Words between displays; a stretch of only blank lines is nothing to draw. */
function words(text: string, from: number): ReadonlyArray<Stretch> {
  const pending = OPENING.exec(text)
  // A fence line that closes a code block already open is the end of that block, not a new one.
  const closing =
    pending !== null &&
    text
      .slice(0, pending.index)
      .split('\n')
      .filter((line) => line.startsWith('```')).length %
      2 ===
      1
  const cut = pending === null || closing ? text.length : pending.index
  const kept = text.slice(0, cut)
  return kept.trim() === '' ? [] : [{ kind: 'words', from, text: kept }]
}

/** Where a program's text stands at the start of a line: inside a string or not, how deeply nested. */
interface Lexical {
  readonly quote: '"' | "'" | null
  readonly depth: number
  /** Whether the line before ended on an operator, so the expression goes on (`a ?`, `x =`). */
  readonly dangling: boolean
}

/** An operator that, ending a line, leaves its expression to the next one. */
const DANGLING = /(?:[?:=,+]|&&|\|\|)\s*$/u

const OPENERS = '([{'
const CLOSERS = ')]}'

/** What one character outside a comment and an escape does to the string and bracket state. */
function readChar(quote: Lexical['quote'], depth: number, c: string) {
  if (quote !== null) return { quote: c === quote ? null : quote, depth }
  if (c === '"' || c === "'") return { quote: c, depth }
  if (OPENERS.includes(c)) return { quote, depth: depth + 1 }
  if (CLOSERS.includes(c)) return { quote, depth: Math.max(0, depth - 1) }
  return { quote, depth }
}

/**
 * One line of a program read as OpenUI's tokenizer reads it: strings in either quote, with
 * backslash escapes, may run across lines, and brackets inside them do not count; a comment
 * (`//` or `#` outside a string) ends what the line says.
 */
function readLine(line: string, from: Lexical): Lexical {
  let { quote, depth } = from
  let code = line.length
  for (let at = 0; at < line.length; at += 1) {
    const c = line.charAt(at)
    if (quote !== null && c === '\\') {
      at += 1
      continue
    }
    if (quote === null && (c === '#' || line.startsWith('//', at))) {
      code = at
      break
    }
    ;({ quote, depth } = readChar(quote, depth, c))
  }
  const said = line.slice(0, code)
  // A comment or blank line says nothing, so it leaves an expression as open as it found it.
  const dangling = said.trim() === '' ? from.dangling : quote === null && DANGLING.test(said)
  return { quote, depth, dangling }
}

/** A line of a program with the lexical state it starts in and where it starts. */
interface ProgramLine {
  readonly start: number
  readonly text: string
  readonly state: Lexical
}

/** A program's lines, each with the state it starts in, and the state after the last. */
function programLines(text: string) {
  const lines: Array<ProgramLine> = []
  let state: Lexical = { quote: null, depth: 0, dangling: false }
  let start = 0
  for (const line of text.split('\n')) {
    lines.push({ start, text: line, state })
    state = readLine(line, state)
    start += line.length + 1
  }
  return { lines, after: state }
}

/** Whether a line is open, still part of the statement before it. */
const continues = (line: ProgramLine) =>
  line.state.quote !== null ||
  line.state.depth > 0 ||
  line.state.dangling ||
  OPERATOR.test(line.text)

/**
 * Where a bare program that starts at the beginning of `text` ends: after its last statement, or
 * after the last line of a statement whose string or brackets are still open. A blank or comment
 * line belongs to the program only when another statement follows it. `null` while the reply so
 * far ends inside an open statement.
 */
function programEnd(text: string): number | null {
  const { lines, after } = programLines(text)
  let end = 0
  for (const line of lines) {
    if (continues(line) || STATEMENT.test(line.text)) {
      end = Math.min(line.start + line.text.length + 1, text.length)
    } else if (line.text.trim() !== '' && !COMMENT.test(line.text)) return end
  }
  return after.quote === null && after.depth === 0 && !after.dangling ? text.length : null
}

/**
 * The closing fence of a program's fence: a line of only backticks outside a string, so a string
 * that holds a fence line stays in the program (upstream `stripFences` skips strings the same way).
 * Open brackets do not hold it: OpenUI's parser closes them itself.
 */
function programClose(body: string): { readonly index: number; readonly length: number } | null {
  const line = programLines(body).lines.find(
    (candidate) => candidate.state.quote === null && CLOSE.test(candidate.text),
  )
  return line === undefined ? null : { index: line.start, length: line.text.length }
}

/** The first place a program starts in a reply: a fence line or a bare `root =` line. */
interface Opening {
  readonly at: number
  /** Where the program's own text begins. */
  readonly body: number
  readonly fenced: boolean
}

/**
 * Whether a fence holds a program: OpenUI's own tags always do; a fence with no tag does when its
 * body starts `root =`. An untagged fence whose first line has not arrived yet is held as a
 * display, since that is what an untagged fence in a reply from Vivid almost always is.
 */
function fencesProgram(tag: string, body: string): boolean {
  if (TAGS.has(tag)) return true
  return tag === '' && (ROOT.test(body) || 'root ='.startsWith(body))
}

/**
 * Finds the next program in `reply`. A fence that is not a program (code in another language, or
 * an untagged fence whose first line is not `root =`) is words, so it is stepped over whole and a
 * `root =` inside it is never taken for a display.
 */
function nextOpening(reply: string): Opening | null {
  let at = 0
  while (at < reply.length) {
    const eol = reply.indexOf('\n', at)
    const line = reply.slice(at, eol === -1 ? reply.length : eol)
    if (ROOT.test(line)) return { at, body: at, fenced: false }
    const fence = FENCE.exec(line)
    if (fence !== null && eol !== -1) {
      if (fencesProgram(fence[1] ?? '', reply.slice(eol + 1).trimStart())) {
        return { at, body: eol + 1, fenced: true }
      }
      // Code in another language is not read as a program: its apostrophes are not strings.
      const close = /^```[ \t]*$/mu.exec(reply.slice(eol + 1))
      if (close === null) return null
      at = eol + 1 + close.index + close[0].length
      continue
    }
    if (eol === -1) return null
    at = eol + 1
  }
  return null
}

/**
 * A reply as its stretches. `from` is where each starts in the reply, which stays the same as more
 * of the reply arrives, so a surface can key what it draws by it and a display is never remounted
 * (and so never loses what the Person picked in it) while the words after it are still coming.
 */
export function stretches(reply: string, from = 0): ReadonlyArray<Stretch> {
  const opening = nextOpening(reply)
  if (opening === null) return words(reply, from)
  const head = words(reply.slice(0, opening.at), from)
  const at = from + opening.at
  const body = reply.slice(opening.body)
  if (!opening.fenced) {
    const end = programEnd(body)
    if (end === null) return [...head, { kind: 'display', from: at, text: body, whole: false }]
    return [
      ...head,
      { kind: 'display', from: at, text: body.slice(0, end), whole: true },
      ...stretches(body.slice(end), from + opening.body + end),
    ]
  }
  const close = programClose(body)
  if (close === null) return [...head, { kind: 'display', from: at, text: body, whole: false }]
  const rest = close.index + close.length
  return [
    ...head,
    { kind: 'display', from: at, text: body.slice(0, close.index), whole: true },
    ...stretches(body.slice(rest), from + opening.body + rest),
  ]
}

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

/** One statement of a display that writes, as OpenUI's parser reports it: the tool it names. */
interface WritingStatement {
  readonly toolAST: { readonly k: string; readonly v?: unknown } | null
}

/**
 * The tools a display names in a `Mutation`. OpenUI's renderer calls the same provider for a
 * `Query` and a `Mutation`, so the surface tells them apart from the program itself: a tool named
 * here is run only when the Person presses the button that runs it.
 */
export const writtenTools = (parsed: {
  readonly mutationStatements: ReadonlyArray<WritingStatement>
}): ReadonlySet<string> =>
  new Set(
    parsed.mutationStatements.flatMap((statement) =>
      statement.toolAST !== null &&
      statement.toolAST.k === 'Str' &&
      Predicate.isString(statement.toolAST.v)
        ? [statement.toolAST.v]
        : [],
    ),
  )

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
 * data; every other outcome is an error whose words the display can show (`result.error`).
 */
export const displayToolResult = (outcome: ToolOutcome): DisplayToolResult =>
  ToolOutcome.match(outcome, {
    Completed: ({ output }) => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    }),
    Rejected: ({ message }) => failed(message),
    Blocked: ({ rule }) => failed(rule),
    ApprovalRequired: ({ summary }) => failed(`This needs your approval first: ${summary}`),
    ConnectionNotReady: ({ serviceName }) => failed(`${serviceName} needs to be connected again.`),
    OutcomeUnknown: () => failed('No answer came back. It may or may not have happened.'),
  })

const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/**
 * One call a display makes into the Person's Integrations, as OpenUI's renderer asks for it: a
 * `Query` unless the program runs this tool in a `Mutation`. The server runs it for the Person.
 */
export const callDisplayTool = Effect.fn('Display.callTool')(function* (
  name: string,
  given: Option.Option<FormState>,
  writes: ReadonlySet<string>,
) {
  const client = yield* VividRpcClient
  const input = yield* decodeJson(Option.getOrElse(given, () => ({})))
  return yield* client.UseDisplayTool({
    name,
    input,
    kind: writes.has(name) ? 'Mutation' : 'Query',
  })
})

/** The answer a surface hands back to the renderer: the server's outcome, or that none came. */
export const displayToolAnswer = <Failure>(
  answered: Result.Result<ToolOutcome, Failure>,
): DisplayToolResult =>
  Result.match(answered, {
    onSuccess: displayToolResult,
    onFailure: () => failed('Vivid could not reach this.'),
  })

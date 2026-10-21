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
const FENCE = /^```([a-z-]*)[ \t]*$/u
const TAGS: ReadonlySet<string> = new Set(['openui-lang', 'openui'])
const ROOT = /^root\s*=/u
/** One statement of a program: `name = ...` or `$name = ...`, never a comparison. */
const STATEMENT = /^\s*\$?[A-Za-z_]\w*\s*=(?!=)/u

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
  const cut = pending === null ? text.length : pending.index
  const kept = text.slice(0, cut)
  return kept.trim() === '' ? [] : [{ kind: 'words', from, text: kept }]
}

/** How far brackets open on a line, outside its double-quoted strings, change the depth. */
function depthAfter(line: string, depth: number): number {
  let inString = false
  let next = depth
  for (let at = 0; at < line.length; at += 1) {
    const c = line[at]
    if (inString) {
      if (c === '\\') at += 1
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '(' || c === '[' || c === '{') next += 1
    else if (c === ')' || c === ']' || c === '}') next -= 1
  }
  return next
}

/**
 * Where a bare program that starts at the beginning of `text` ends: after its last statement, or
 * after the last line of a statement whose brackets are still open. A blank line belongs to the
 * program only when another statement follows it. `null` while the reply so far ends inside a
 * statement whose brackets are still open.
 */
function programEnd(text: string): number | null {
  const lines = text.split('\n')
  let depth = 0
  let end = 0
  let at = 0
  for (const line of lines) {
    const inside = depth > 0 || STATEMENT.test(line)
    if (!inside && line.trim() !== '') return end
    depth = Math.max(0, depthAfter(line, depth))
    at += line.length + 1
    if (inside) end = Math.min(at, text.length)
  }
  return depth === 0 ? text.length : null
}

/** The first place a program starts in a reply: a fence line or a bare `root =` line. */
interface Opening {
  readonly at: number
  /** Where the program's own text begins. */
  readonly body: number
  readonly fenced: boolean
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
      const body = reply.slice(eol + 1).trimStart()
      const tag = fence[1] ?? ''
      // An untagged fence whose first line has not arrived yet is held as a display: it is drawn
      // as one if it turns out to be a program, which is what an untagged fence in a reply
      // from Vivid almost always is.
      const program =
        TAGS.has(tag) || (tag === '' && (ROOT.test(body) || 'root ='.startsWith(body)))
      if (program) return { at, body: eol + 1, fenced: true }
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
  const close = /^```[ \t]*$/mu.exec(body)
  if (close === null) return [...head, { kind: 'display', from: at, text: body, whole: false }]
  const rest = close.index + close[0].length
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

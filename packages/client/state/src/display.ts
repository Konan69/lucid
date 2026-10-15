import { ToolOutcome } from '@vivid/contracts'
import { Option, Predicate, Schema } from 'effect'

/**
 * A display is part of Vivid's reply: a short program in OpenUI Lang between the fences OpenUI's
 * inline mode has the model write (three backticks and `openui-lang`). Each surface draws it with
 * OpenUI's renderer and its own parts, in place, while the reply is still arriving. Nothing is
 * fetched and there is no second copy: the reply is the record.
 */
const OPEN = '```openui-lang'

/** A stretch of a reply, in order: words to read, or a display to draw. */
export type Stretch =
  | { readonly kind: 'words'; readonly from: number; readonly text: string }
  | {
      readonly kind: 'display'
      readonly from: number
      readonly text: string
      /** Whether its closing fence has arrived. Until then the renderer draws what it has. */
      readonly whole: boolean
    }

/** A fence line the reply is in the middle of writing, which is not words to show yet. */
const OPENING = /(?:^|\n)`{1,3}[a-z-]*$/u

/** Words between displays; a stretch of only blank lines is nothing to draw. */
function words(text: string, from: number): ReadonlyArray<Stretch> {
  const pending = OPENING.exec(text)
  const cut = pending !== null && OPEN.startsWith(pending[0].trim()) ? pending.index : text.length
  const kept = text.slice(0, cut)
  return kept.trim() === '' ? [] : [{ kind: 'words', from, text: kept }]
}

/**
 * A reply as its stretches. `from` is where each starts in the reply, which stays the same as more
 * of the reply arrives, so a surface can key what it draws by it and a display is never remounted
 * (and so never loses what the Person picked in it) while the words after it are still coming.
 */
export function stretches(reply: string, from = 0): ReadonlyArray<Stretch> {
  const open = reply.indexOf(OPEN)
  if (open === -1) return words(reply, from)
  const head = words(reply.slice(0, open), from)
  const line = reply.indexOf('\n', open)
  // The fence line itself is still arriving: nothing of the display is known yet.
  if (line === -1) return head
  const body = reply.slice(line + 1)
  const close = /^```[ \t]*$/mu.exec(body)
  const at = from + open
  if (close === null) return [...head, { kind: 'display', from: at, text: body, whole: false }]
  const rest = close.index + close[0].length
  return [
    ...head,
    { kind: 'display', from: at, text: body.slice(0, close.index), whole: true },
    ...stretches(body.slice(rest), from + line + 1 + rest),
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

import { createParser, type ASTNode } from '@openuidev/lang-core'
import {
  DisplayProgramRefused,
  DisplaySource,
  DisplayToolKind,
  RunCodeRequest,
  RuntimeUnavailable,
  ThreadId,
  type NotFound,
  type PersonId,
} from '@vivid/contracts'
import { stretches } from '@vivid/contracts/display'
import { Cache, Context, Data, Duration, Effect, Layer, Option, Schema } from 'effect'
import { HttpClientResponse } from 'effect/http'
import { FeedStore } from '../feed/store.ts'
import { Runtime } from '../runtime/client.ts'
import { requireThread } from '../threads/access.ts'
import type { Database, DatabaseInfrastructureError } from '../database/client.ts'

/** Flue identifies final assistant responses by their submission's durable settlement. */
const History = Schema.Struct({
  incarnation: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      submissionId: Schema.optional(Schema.String),
      parts: Schema.Array(Schema.Json),
    }),
  ),
  settlements: Schema.Array(Schema.Struct({ submissionId: Schema.String })),
})
const decodeHistory = HttpClientResponse.schemaBodyJson(History)
const isText = Schema.is(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }))
const refusal = { message: DisplayProgramRefused.fields.message.literal }
const Program = Schema.Struct({ ...RunCodeRequest.fields, kind: DisplayToolKind })
const StoredPrograms = Schema.TaggedUnion({
  Waiting: {},
  Final: { programs: Schema.Array(Program), computed: Schema.Boolean },
})
export const DisplayAdmission = Schema.TaggedUnion({
  Waiting: {},
  Ready: { thread: ThreadId, kind: DisplayToolKind },
})
/** Component schemas affect drawing only; reserved Query/Mutation ASTs are parser-owned. */
const parser = createParser({})
const decodeProgram = Schema.decodeUnknownOption(RunCodeRequest)

/** Computed expressions are not persisted program declarations. Only exact literal arguments count. */
function literalProgram(args: ASTNode | null) {
  if (args === null || args.k !== 'Obj' || args.entries.length !== 2) return []
  const code = args.entries.find(([name]) => name === 'code')
  const summary = args.entries.find(([name]) => name === 'summary')
  if (code === undefined || summary === undefined) return []
  if (code[1].k !== 'Str' || summary[1].k !== 'Str') return []
  return Option.toArray(decodeProgram({ code: code[1].v, summary: summary[1].v }))
}

/** Only a literal tool name establishes that this declaration names the program interpreter. */
const isRunCode = (tool: ASTNode | null) =>
  tool !== null && tool.k === 'Str' && tool.v === 'run_code'

/** Use the same stretch finder and parser as drawing; quoted prose is never executable evidence. */
function declarations(text: string) {
  const parsed = stretches(text).flatMap((stretch) =>
    stretch.kind === 'display' && stretch.whole ? [parser.parse(stretch.text)] : [],
  )
  // A computed name or argument could invoke the other kind's literal program. It cannot prove
  // disjoint authority, so do not let an automatic call borrow that declaration's press policy.
  const computed = parsed.some((program) =>
    [...program.queryStatements, ...program.mutationStatements].some((statement) => {
      if (statement.toolAST === null || statement.toolAST.k !== 'Str') return true
      return statement.toolAST.v === 'run_code' && literalProgram(statement.argsAST).length === 0
    }),
  )
  const programs = parsed.flatMap((tree) => {
    const queries = tree.queryStatements.flatMap((statement) =>
      statement.complete && isRunCode(statement.toolAST)
        ? literalProgram(statement.argsAST).map((program) =>
            Program.make({
              code: program.code,
              summary: program.summary,
              kind: 'Query',
            }),
          )
        : [],
    )
    const mutations = tree.mutationStatements.flatMap((statement) =>
      isRunCode(statement.toolAST)
        ? literalProgram(statement.argsAST).map((program) =>
            Program.make({
              code: program.code,
              summary: program.summary,
              kind: 'Mutation',
            }),
          )
        : [],
    )
    return queries.concat(mutations)
  })
  return { programs, computed }
}

/** A parsed declaration belongs to the exact response in one Flue stream incarnation. */
class Message extends Data.Class<{
  readonly thread: ThreadId
  readonly message: string
  readonly incarnation: string
  readonly text: string
}> {}

/**
 * Re-read active history before consulting parsed declarations. Flue 2.2.2 resets its projection
 * for compaction or superseded errors without a new incarnation; retry can replace reply content.
 * An incarnation key alone cannot prove a cached response is still on that active path.
 */
const messagePrograms = Effect.fn('Code.messagePrograms')(function* (
  source: Pick<Message, 'thread' | 'message'>,
  messages: Cache.Cache<Message, typeof StoredPrograms.cases.Final.Type>,
) {
  const response = yield* (yield* Runtime).read({
    threadId: source.thread,
    suffix: '',
    search: '?view=history',
    accept: 'application/json',
  })
  if (response.status !== 200)
    return yield* new RuntimeUnavailable({ message: 'Display response could not be read' })
  const history = yield* decodeHistory(response).pipe(
    Effect.mapError(() => new RuntimeUnavailable({ message: 'Display response is invalid' })),
  )
  const message = history.messages.find((candidate) => candidate.id === source.message)
  // An absent message during a live submission is a wait, never cached as an authorship refusal.
  if (message === undefined) {
    const arriving = history.messages.some(
      (candidate) =>
        candidate.submissionId !== undefined &&
        !history.settlements.some(
          (settlement) => settlement.submissionId === candidate.submissionId,
        ),
    )
    if (arriving) return StoredPrograms.cases.Waiting.make({})
    return yield* new DisplayProgramRefused(refusal)
  }
  if (message.role !== 'assistant' || message.submissionId === undefined)
    return yield* new DisplayProgramRefused(refusal)
  if (!history.settlements.some((settlement) => settlement.submissionId === message.submissionId))
    return StoredPrograms.cases.Waiting.make({})
  const text = message.parts
    .filter(isText)
    .map((part) => part.text)
    .join('\n\n')
  return yield* Cache.get(
    messages,
    new Message({
      thread: source.thread,
      message: source.message,
      incarnation: history.incarnation,
      text,
    }),
  )
}, Effect.scoped)

type SourceFailure =
  | DisplayProgramRefused
  | NotFound
  | RuntimeUnavailable
  | DatabaseInfrastructureError

/** Both persisted authorities project the same declarations while retaining their I/O failures. */
type StoredDisplay = Effect.Effect<
  { readonly thread: ThreadId; readonly stored: typeof StoredPrograms.Type },
  SourceFailure,
  Database | Runtime | FeedStore
>

interface CodeSourceService {
  readonly resolve: (
    source: DisplaySource,
    person: PersonId,
    request: RunCodeRequest,
  ) => Effect.Effect<typeof DisplayAdmission.Type, SourceFailure, Database | Runtime | FeedStore>
}

/** Parsed source authority owns the bounded final-message cache, while access stays per request. */
export class CodeSource extends Context.Service<CodeSource, CodeSourceService>()(
  'vivid/CodeSource',
) {}

/** Cache parsing only. Current access, active-path presence and settlement are checked on every draw. */
export const codeSourceLayer = Layer.effect(
  CodeSource,
  Effect.gen(function* () {
    const messages = yield* Cache.make({
      capacity: 256,
      lookup: (message: Message) =>
        Effect.sync(() => StoredPrograms.cases.Final.make(declarations(message.text))),
      timeToLive: Duration.infinity,
    })
    return CodeSource.of({
      resolve: Effect.fn('Code.resolveSource')(function* (source, person, request) {
        const stored = yield* DisplaySource.match<StoredDisplay>(source, {
          ThreadMessage: (message) =>
            Effect.gen(function* () {
              yield* requireThread(message.thread, person)
              return {
                thread: message.thread,
                stored: yield* messagePrograms(message, messages),
              }
            }),
          FeedPost: ({ post }) =>
            Effect.gen(function* () {
              const [display] = yield* (yield* FeedStore).display(person, post)
              if (display === undefined || display.text === null)
                return yield* new DisplayProgramRefused(refusal)
              return {
                thread: display.thread,
                stored: StoredPrograms.cases.Final.make(declarations(display.text)),
              }
            }),
        })
        if (StoredPrograms.guards.Waiting(stored.stored))
          return DisplayAdmission.cases.Waiting.make({})
        if (stored.stored.computed) return yield* new DisplayProgramRefused(refusal)
        const matches = stored.stored.programs.filter((program) => program.code === request.code)
        const kinds = new Set(matches.map((program) => program.kind))
        const exact = matches.find((program) => program.summary === request.summary)
        if (exact === undefined || kinds.size !== 1)
          return yield* new DisplayProgramRefused(refusal)
        return DisplayAdmission.cases.Ready.make({ thread: stored.thread, kind: exact.kind })
      }),
    })
  }),
)

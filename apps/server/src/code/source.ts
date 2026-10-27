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
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Schema } from 'effect'
import { FeedStore } from '../feed/store.ts'
import { Runtime } from '../runtime/client.ts'
import { readThreadHistory } from '../runtime/history.ts'
import { requireThread } from '../threads/access.ts'
import type { Database, DatabaseInfrastructureError } from '../database/client.ts'

/** UX policy for bursts of display draws. Reuse one snapshot for two seconds; a missing
 * message forces a new fetch and failed reads are never cached. */
const HISTORY_FRESHNESS = Duration.seconds(2)

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

/** Read and decode once per burst; no response body or HTTP resource escapes its scope. */
const readHistory = Effect.fn('Code.readDisplayHistory')(function* (thread: ThreadId) {
  return yield* readThreadHistory(yield* Runtime, thread)
}, Effect.scoped)

/**
 * Resolve against a short-lived canonical projection and its settlement.
 * Replies may change or disappear, so cached snapshots must expire.
 */
const messagePrograms = Effect.fn('Code.messagePrograms')(function* (
  source: typeof DisplaySource.cases.ThreadMessage.Type,
  histories: Cache.Cache<
    ThreadId,
    Effect.Success<ReturnType<typeof readHistory>>,
    Effect.Error<ReturnType<typeof readHistory>>,
    Effect.Services<ReturnType<typeof readHistory>>
  >,
) {
  const cached = yield* Cache.get(histories, source.thread)
  // A snapshot from just before this reply's submission began lacks the message and shows nothing
  // pending, which would read as a refusal; one fresh read decides an absent message instead.
  const history = cached.messages.some((candidate) => candidate.id === source.message)
    ? cached
    : yield* Cache.invalidate(histories, source.thread).pipe(
        Effect.andThen(Cache.get(histories, source.thread)),
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
  return StoredPrograms.cases.Final.make(declarations(text))
})

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

/** Source authority owns shared history snapshots, while access stays per request. */
export class CodeSource extends Context.Service<CodeSource, CodeSourceService>()(
  'vivid/CodeSource',
) {}

/**
 * Share pending and successful history reads across a Thread's draws for two seconds, bounded
 * to 256 Threads. The returned incarnation belongs to that snapshot, never a permanent authority
 * key. Expiry rechecks same-incarnation replacements and resets; failures remain retryable.
 */
export const codeSourceLayer = Layer.effect(
  CodeSource,
  Effect.gen(function* () {
    const histories = yield* Cache.makeWith(readHistory, {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? HISTORY_FRESHNESS : Duration.zero),
      requireServicesAt: 'lookup',
    })
    return CodeSource.of({
      resolve: Effect.fn('Code.resolveSource')(function* (source, person, request) {
        const stored = yield* DisplaySource.match<StoredDisplay>(source, {
          ThreadMessage: (message) =>
            Effect.gen(function* () {
              yield* requireThread(message.thread, person)
              return {
                thread: message.thread,
                stored: yield* messagePrograms(message, histories),
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

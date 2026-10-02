import {
  BrowseOutcome,
  BrowseRequest,
  CommandOutcome,
  FindToolsRequest,
  ReadPageOutcome,
  ReadPageRequest,
  RunCommandRequest,
  ToolOutcome,
} from '@vivid/contracts'
import { Context, Effect, Layer, Schema } from 'effect'
import type { Actor } from '../auth/access.ts'
import { findTools, resolveTool, useTool } from '../connections/tools.ts'
import { computerBrowse, computerRunCommand } from '../computers/store.ts'
import { CodeAuthority, type CodeBoundary } from './authority.ts'
import { PageReader } from './page.ts'
import { CallOutcome, type Dispatch } from './process.ts'
import type { WorkerMessage } from './protocol.ts'

const text = (maximum: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum))
const UseNamedTool = Schema.Struct({
  account: text(300),
  tool: text(200),
  input: Schema.Json,
  summary: text(200),
  rationale: Schema.String.check(Schema.isMaxLength(400)),
})
const decodeUse = Schema.decodeUnknownEffect(UseNamedTool)
const decodeFind = Schema.decodeUnknownEffect(FindToolsRequest)
const decodeCommand = Schema.decodeUnknownEffect(RunCommandRequest)
const decodeBrowse = Schema.decodeUnknownEffect(BrowseRequest)
const decodePage = Schema.decodeUnknownEffect(ReadPageRequest)

/** Only human metadata is projected; Vivid's Connection references never enter discovery results. */
function toolView(response: Awaited<Effect.Success<ReturnType<typeof findTools>>>) {
  return {
    tools: response.tools.map((item) => ({
      account: item.account,
      tool: item.name,
      description: item.description,
      effect: item.effect,
      input: item.input,
    })),
    unconnected: response.unconnected.map((item) => ({
      service: item.name,
      description: item.description,
    })),
  }
}

/** Recoverable provider refusals stay typed JSON data; approval/blocked/unknown never reach the guest. */
const returned = (
  value: Schema.Json,
  summary: string,
  end: 'completed' | 'refused' = 'completed',
) => CallOutcome.cases.Returned.make({ value, summary, end })

/** Resolve under current authority; the existing owner rechecks provider metadata and gates the action. */
const connection = Effect.fn('Code.useConnection')(function* (actor: Actor, input: Schema.Json) {
  const request = yield* decodeUse(input, { onExcessProperty: 'error' })
  const matched = yield* resolveTool(actor, request)
  const outcome = yield* useTool(actor, {
    connectionId: matched.connectionId,
    tool: matched.name,
    input: request.input,
    summary: request.summary,
    rationale: request.rationale,
  })
  return ToolOutcome.match<CallOutcome>(outcome, {
    Completed: ({ output }) => returned({ ok: true, output }, request.summary),
    ApprovalRequired: ({ approvalId, summary }) =>
      CallOutcome.cases.ApprovalRequired.make({ approvalId, summary }),
    Blocked: ({ rule }) => CallOutcome.cases.Blocked.make({ rule, summary: request.summary }),
    OutcomeUnknown: () => CallOutcome.cases.Unknown.make({ summary: request.summary }),
    ConnectionNotReady: () =>
      returned({ ok: false, reason: 'The account needs connecting.' }, request.summary, 'refused'),
    Rejected: () =>
      returned(
        { ok: false, reason: 'The service rejected the action.' },
        request.summary,
        'refused',
      ),
  })
})

/** Computer's existing contracts collapse lost execution and availability; conservatively stop on either. */
const command = Effect.fn('Code.runCommand')(function* (actor: Actor, input: Schema.Json) {
  const request = yield* decodeCommand(input, { onExcessProperty: 'error' })
  if (
    request.timeoutSeconds !== undefined &&
    (request.timeoutSeconds < 1 || request.timeoutSeconds > 30)
  )
    return returned(
      { ok: false, reason: 'Command timeout must be between 1 and 30 seconds.' },
      request.summary,
      'refused',
    )
  return CommandOutcome.match<CallOutcome>(yield* computerRunCommand(actor, request), {
    Completed: ({ result }) =>
      returned(
        {
          ok: true,
          result: { exitCode: result.exitCode, output: result.output, truncated: result.truncated },
        },
        request.summary,
      ),
    ApprovalRequired: ({ approvalId, summary }) =>
      CallOutcome.cases.ApprovalRequired.make({ approvalId, summary }),
    Blocked: ({ rule }) => CallOutcome.cases.Blocked.make({ rule, summary: request.summary }),
    Unavailable: () => CallOutcome.cases.Unknown.make({ summary: request.summary }),
  })
})

/** Browser results expose readable content, never Computer or session references or screen URLs. */
const browse = Effect.fn('Code.browse')(function* (actor: Actor, input: Schema.Json) {
  const request = yield* decodeBrowse(input, { onExcessProperty: 'error' })
  return BrowseOutcome.match<CallOutcome>(yield* computerBrowse(actor, request), {
    Completed: ({ result }) =>
      returned(
        {
          ok: true,
          result: { title: result.title, outline: result.outline, truncated: result.truncated },
        },
        request.summary,
      ),
    ApprovalRequired: ({ approvalId, summary }) =>
      CallOutcome.cases.ApprovalRequired.make({ approvalId, summary }),
    Blocked: ({ rule }) => CallOutcome.cases.Blocked.make({ rule, summary: request.summary }),
    Unavailable: () => CallOutcome.cases.Unknown.make({ summary: request.summary }),
  })
})

/** Only these five tools exist. Payload ownership fields are excess properties and rejected at ingress. */
const dispatch = Effect.fn('Code.dispatch')(function* (
  boundary: CodeBoundary,
  call: typeof WorkerMessage.cases.Call.Type,
) {
  const actor = yield* (yield* CodeAuthority).refresh(boundary)
  switch (call.kind) {
    case 'find_tools': {
      const request = yield* decodeFind(call.input, { onExcessProperty: 'error' })
      return returned(toolView(yield* findTools(actor, request)), request.query)
    }
    case 'use_tool':
      return yield* connection(actor, call.input)
    case 'run_command':
      return yield* command(actor, call.input)
    case 'browse':
      return yield* browse(actor, call.input)
    case 'read_page': {
      const request = yield* decodePage(call.input, { onExcessProperty: 'error' })
      const outcome = yield* (yield* PageReader).read(request)
      return ReadPageOutcome.match(outcome, {
        Read: ({ address, title, text: content, truncated }) =>
          returned({ ok: true, address, title, text: content, truncated }, 'Read a public page'),
        Refused: ({ reason }) => returned({ ok: false, reason }, 'Read a public page', 'refused'),
      })
    }
  }
  // Decoded call kinds are exhaustive; adding one makes this return incompatible with CallOutcome.
  return call.kind
})

export interface CodeCallsService {
  readonly bind: (boundary: CodeBoundary) => Dispatch
}

/** Binding captures trusted services, not guest input. Refresh occurs inside dispatch, after queuing. */
export class CodeCalls extends Context.Service<CodeCalls, CodeCallsService>()('vivid/CodeCalls') {}

export const codeCallsLayer = Layer.effect(
  CodeCalls,
  Effect.gen(function* () {
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof dispatch>>>()
    return CodeCalls.of({
      bind: (boundary) =>
        Effect.fn('Code.boundCall')((call) =>
          dispatch(boundary, call).pipe(
            Effect.provide(context),
            Effect.catchTag('CodeAuthorityRevoked', () =>
              Effect.succeed(
                CallOutcome.cases.Blocked.make({
                  rule: 'The Person can no longer act in this Thread.',
                  summary: 'Check current authority',
                }),
              ),
            ),
            Effect.catchTags({
              SchemaError: () =>
                Effect.succeed(
                  returned(
                    { ok: false, reason: 'The tool arguments are invalid.' },
                    'Check tool arguments',
                    'refused',
                  ),
                ),
              NotFound: () =>
                Effect.succeed(
                  returned(
                    { ok: false, reason: 'That tool is not available here.' },
                    'Find the tool',
                    'refused',
                  ),
                ),
              InvalidRequest: () =>
                Effect.succeed(
                  returned(
                    { ok: false, reason: 'The request was refused.' },
                    'Check the request',
                    'refused',
                  ),
                ),
              Conflict: () =>
                Effect.succeed(
                  returned(
                    { ok: false, reason: 'The account changed; discover its tools again.' },
                    'Check the account',
                    'refused',
                  ),
                ),
            }),
            Effect.catch(() =>
              Effect.succeed(
                CallOutcome.cases.Unknown.make({ summary: 'The call could not be confirmed' }),
              ),
            ),
          ),
        ),
    })
  }),
)

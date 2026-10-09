import {
  BrowseOutcome,
  BrowseRequest,
  CodeCallKind,
  FindToolsRequest,
  ReadPageOutcome,
  ReadPageRequest,
  ToolOutcome,
} from '@vivid/contracts'
import { Context, Effect, Layer, Schema } from 'effect'
import { DecisionModel } from 'effect/unstable/ai'
import { CodeToolNames } from '@vivid/contracts/code'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { ToolEffects } from '../connections/effects.ts'
import type { Actor } from '../auth/access.ts'
import { Gate } from '../approvals/gate.ts'
import { Executor } from '../connections/executor.ts'
import { ConnectionStore } from '../connections/store.ts'
import { findTools, resolveTool, useTool } from '../connections/tools.ts'
import { DeviceRegistry } from '../computers/device.ts'
import { ComputerStore, computerBrowse } from '../computers/store.ts'
import { Database } from '../database/client.ts'
import { CodeAuthority, type CodeBoundary } from './authority.ts'
import { PageReader } from './page.ts'
import { readPage } from './pages.ts'
import { CallOutcome, type Dispatch, type ProgramCall } from './process.ts'

const text = (maximum: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum))
const UseNamedTool = Schema.Struct({
  ...CodeToolNames.fields,
  input: Schema.Json,
  summary: text(200),
  rationale: Schema.String.check(Schema.isMaxLength(400)),
})
const decodeUse = Schema.decodeUnknownEffect(UseNamedTool)
const decodeFind = Schema.decodeUnknownEffect(FindToolsRequest)
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
      call: item.call,
      signature: item.signature,
    })),
    unconnected: response.unconnected.map((item) => ({
      service: item.name,
      description: item.description,
    })),
  }
}

/** Recoverable provider refusals stay typed JSON data; approval/blocked/unknown never reach the program. */
const returned = (
  value: Schema.Json,
  summary: string,
  end: 'completed' | 'refused' = 'completed',
) => CallOutcome.cases.Returned.make({ value, summary, end })

/** Typed recovery here decides a new refusal; carried Tool, Page and Device replies bypass it. */
// Untraced, as `recordRefusal` is: the event belongs on the producer's span, not a child of it.
const refused = Effect.fnUntraced(function* (
  call: CodeCallKind,
  value: Schema.Json,
  summary: string,
) {
  yield* recordRefusal(Refusal.cases.CallRefused.make({ call }))
  return returned(value, summary, 'refused')
})

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
    Rejected: ({ message, problems }) =>
      returned({ ok: false, reason: message, problems }, request.summary, 'refused'),
  })
})

/** Browser results expose readable content, never Computer or session references or screen URLs. */
const browse = Effect.fn('Code.browse')(function* (actor: Actor, input: Schema.Json) {
  const request = yield* decodeBrowse(input, { onExcessProperty: 'error' })
  const outcome = yield* computerBrowse(actor, request)
  // Each exhaustive branch owns whether this is a new code refusal or a carried Device reply.
  // New outcomes must choose their recording Effect here; there is no separate recording list.
  return yield* BrowseOutcome.match<Effect.Effect<CallOutcome>>(outcome, {
    NotConnected: () =>
      refused(
        'browse',
        { ok: false, reason: 'The Person’s desktop app is not connected. Ask them to connect it.' },
        request.summary,
      ),
    // The Device already recorded AddressRefused, Stopped, PageGone and Unsupported.
    AddressRefused: () =>
      Effect.succeed(
        returned(
          {
            ok: false,
            reason:
              'That page or address cannot be opened on the Person’s computer. Use a public web address.',
          },
          request.summary,
          'refused',
        ),
      ),
    NotAllowed: () =>
      refused(
        'browse',
        {
          ok: false,
          reason:
            'The Person has not allowed access to their computer. Ask them to allow it in the desktop app.',
        },
        request.summary,
      ),
    Busy: () =>
      refused(
        'browse',
        {
          ok: false,
          reason: 'The Person’s computer is busy with an earlier action. Wait for it to finish.',
        },
        request.summary,
      ),
    Stopped: () =>
      Effect.succeed(
        returned(
          {
            ok: false,
            reason: 'The Person took control of the page. Stop and do not retry by yourself.',
          },
          request.summary,
          'refused',
        ),
      ),
    PageGone: () =>
      Effect.succeed(
        returned(
          { ok: false, reason: 'The page is gone. Ask the Person to open it again.' },
          request.summary,
          'refused',
        ),
      ),
    Unsupported: () =>
      Effect.succeed(
        returned(
          {
            ok: false,
            reason:
              'The Person’s computer does not support this browser action. Ask the Person to do it.',
          },
          request.summary,
          'refused',
        ),
      ),
    RunRequired: () =>
      refused(
        'browse',
        {
          ok: false,
          reason:
            'Nothing was sent, because the work that asked for it has ended. Ask the Person before trying again.',
        },
        request.summary,
      ),
    Completed: ({ result }) =>
      Effect.succeed(
        returned(
          {
            ok: true,
            result: { title: result.title, outline: result.outline, truncated: result.truncated },
          },
          request.summary,
        ),
      ),
    ApprovalRequired: ({ approvalId, summary }) =>
      Effect.succeed(CallOutcome.cases.ApprovalRequired.make({ approvalId, summary })),
    Blocked: ({ rule }) =>
      Effect.succeed(CallOutcome.cases.Blocked.make({ rule, summary: request.summary })),
    Unavailable: ({ reason }) => refused('browse', { ok: false, reason }, request.summary),
    OutcomeUnknown: () =>
      Effect.succeed(CallOutcome.cases.Unknown.make({ summary: request.summary })),
  })
})

/** Only these four tools exist. Payload ownership fields are excess properties and rejected at ingress. */
const dispatch = Effect.fn('Code.dispatch')(function* (boundary: CodeBoundary, call: ProgramCall) {
  const actor = yield* (yield* CodeAuthority).refresh(boundary)
  switch (call.kind) {
    case 'find_tools': {
      const request = yield* decodeFind(call.input, { onExcessProperty: 'error' })
      return returned(toolView(yield* findTools(actor, request)), request.query)
    }
    case 'use_tool':
      return yield* connection(actor, call.input)
    case 'browse':
      return yield* browse(actor, call.input)
    case 'read_page': {
      const request = yield* decodePage(call.input, { onExcessProperty: 'error' })
      const outcome = yield* readPage(request)
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

/** Binding captures trusted services, not program input. Refresh occurs inside dispatch, after queuing. */
export class CodeCalls extends Context.Service<CodeCalls, CodeCallsService>()('vivid/CodeCalls') {}

export const codeCallsLayer = Layer.effect(
  CodeCalls,
  Effect.gen(function* () {
    // A derived capture silently absorbs new scoped dependencies. Pick only these authorities so
    // future dispatch requirements fail typecheck and the Run's Scope and parent span stay local.
    const context = Context.pick(
      CodeAuthority,
      Gate,
      Executor,
      ConnectionStore,
      ToolEffects,
      DecisionModel.DecisionModel,
      DeviceRegistry,
      ComputerStore,
      Database,
      PageReader,
    )(
      yield* Effect.context<
        | CodeAuthority
        | Gate
        | Executor
        | ConnectionStore
        | ToolEffects
        | DecisionModel.DecisionModel
        | DeviceRegistry
        | ComputerStore
        | Database
        | PageReader
      >(),
    )
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
                refused(
                  call.kind,
                  { ok: false, reason: 'The tool arguments are invalid.' },
                  'Check tool arguments',
                ),
              NotFound: () =>
                refused(
                  call.kind,
                  { ok: false, reason: 'That tool is not available here.' },
                  'Find the tool',
                ),
              InvalidRequest: () =>
                refused(
                  call.kind,
                  { ok: false, reason: 'The request was refused.' },
                  'Check the request',
                ),
              Conflict: () =>
                refused(
                  call.kind,
                  { ok: false, reason: 'The account changed; discover its tools again.' },
                  'Check the account',
                ),
            }),
            // Owning adapters report post-dispatch loss as values. Remaining typed errors are
            // pre-dispatch refusals; defects deliberately bypass this typed recovery.
            Effect.catch(() =>
              refused(
                call.kind,
                { ok: false, reason: 'The service is unavailable. No action was sent.' },
                'Check service availability',
              ),
            ),
            // Tool/Page/Device refusals and Gate Blocked decisions are recorded by their owners.
            // CodeAuthorityRevoked also returns Blocked, but has no Gate decision and no matching
            // Refusal case; authority revocation remains unrecorded in this vocabulary.
          ),
        ),
    })
  }),
)

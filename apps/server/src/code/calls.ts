import { ActionLookup } from '../actions/journal.ts'
import { IntegrationAnswers } from '../connections/answers.ts'
import {
  ActionApplied,
  BrowseOutcome,
  BrowseRequest,
  CodeCallKind,
  DisplayCallPolicy,
  ConnectionState,
  displayCallRefusal,
  FindToolsRequest,
  NotFound,
  ReadPageOutcome,
  ReadPageRequest,
  ToolOutcome,
} from '@vivid/contracts'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { DecisionModel } from 'effect/ai'
import { CodeToolNames } from '@vivid/contracts/code'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { ToolEffects } from '../connections/effects.ts'
import type { Actor } from '../auth/access.ts'
import { Gate } from '../approvals/gate.ts'
import { Executor } from '../connections/executor.ts'
import { ExecutorMembers } from '../connections/members.ts'
import { ConnectionStore } from '../connections/store.ts'
import { findTools, resolveTool, useUnkeyedTool, useQueryTool } from '../connections/tools.ts'
import { DeviceRegistry } from '../computers/device.ts'
import { ComputerStore, computerBrowse } from '../computers/store.ts'
import { Database } from '../database/client.ts'
import { CodeAuthority, type CodeBoundary } from './authority.ts'
import { PageReader } from './page.ts'
import { readPage } from './pages.ts'
import { CallOutcome, type Dispatch } from './process.ts'
import type { WorkerMessage } from './protocol.ts'

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

/** What a program reads when the exact same act's earlier send has an unknown result. */
const RECONCILE_FIRST =
  'The same action was sent before in this Thread and its result is not known yet, so it was not sent again. Do not retry it; tell the Person.'

/** Recoverable provider refusals stay typed JSON data; approval/blocked/unknown never reach the guest. */
const returned = (
  value: Schema.Json,
  summary: string,
  end: 'completed' | 'refused' = 'completed',
) => CallOutcome.cases.Returned.make({ value, summary, end, receipt: null })

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
const connection = Effect.fn('Code.useConnection')(function* (
  actor: Actor,
  input: Schema.Json,
  policy: DisplayCallPolicy,
) {
  const request = yield* decodeUse(input, { onExcessProperty: 'error' })
  const { connections } = yield* (yield* ConnectionStore).list(actor)
  const connection = connections.find(
    (entry) => entry.account.toLowerCase() === request.account.trim().toLowerCase(),
  )
  if (connection === undefined) return yield* new NotFound({ message: 'Tool not found' })
  const saved = { connectionId: connection.id, name: request.tool }
  const matched = yield* ConnectionState.guards.Ready(connection.state)
    ? resolveTool(actor, request).pipe(Effect.catchTag('NotFound', () => Effect.succeed(saved)))
    : Effect.succeed(saved)
  const use = DisplayCallPolicy.match(policy, {
    Draw: () => useQueryTool,
    Press: () => useUnkeyedTool,
  })
  const sent = yield* use(actor, {
    connectionId: matched.connectionId,
    tool: matched.name,
    input: request.input,
    summary: request.summary,
    rationale: request.rationale,
  }).pipe(
    Effect.asSome,
    Effect.catchTag('ActionReconciliationRequired', () => Effect.succeedNone),
  )
  // The same act sent earlier in this Thread has an unknown result: the program is told, and it
  // is not sent again. The program goes on with its other work.
  if (Option.isNone(sent))
    return yield* refused('use_tool', { ok: false, reason: RECONCILE_FIRST }, request.summary)
  const result = sent.value
  const evidence = { coverage: result.coverage, asOf: result.asOf, observedAt: result.observedAt }
  return ToolOutcome.match<CallOutcome>(result.outcome, {
    Accepted: ({ output, receipt }) =>
      CallOutcome.cases.Returned.make({
        value: {
          ok: true,
          output,
          message: 'The service accepted the action; it is queued, not confirmed yet.',
          ...evidence,
        },
        summary: request.summary,
        end: 'accepted',
        receipt,
      }),
    Completed: ({ output, receipt }) =>
      CallOutcome.cases.Returned.make({
        value: { ok: true, output, ...evidence },
        summary: request.summary,
        end: 'completed',
        receipt,
      }),
    Repeated: ({ receipt }) =>
      CallOutcome.cases.Returned.make({
        value: { ok: true, output: null, repeated: true, ...evidence },
        summary: request.summary,
        end: ActionApplied.guards.Accepted(receipt) ? 'accepted' : 'completed',
        receipt,
      }),
    InputRequired: ({ requestId, questions }) =>
      CallOutcome.cases.InputRequired.make({ requestId, questions, summary: request.summary }),
    ApprovalRequired: ({ approvalId, summary }) =>
      CallOutcome.cases.ApprovalRequired.make({ approvalId, summary }),
    Blocked: ({ rule }) => CallOutcome.cases.Blocked.make({ rule, summary: request.summary }),
    OutcomeUnknown: ({ receipt }) =>
      CallOutcome.cases.Unknown.make({ summary: request.summary, receipt }),
    ScopeRequired: ({ required, granted }) =>
      returned(
        { ok: false, reason: 'Additional access required.', required, granted, ...evidence },
        request.summary,
        'refused',
      ),
    PermissionDeclined: ({ classes }) =>
      returned(
        { ok: false, reason: 'Data permission declined.', classes, ...evidence },
        request.summary,
        'refused',
      ),
    Unsupported: ({ capability }) =>
      returned(
        { ok: false, reason: 'Unsupported capability.', capability, ...evidence },
        request.summary,
        'refused',
      ),
    ConnectionNotReady: () =>
      returned(
        { ok: false, reason: 'The account needs connecting.', ...evidence },
        request.summary,
        'refused',
      ),
    Rejected: ({ message, problems }) =>
      returned({ ok: false, reason: message, problems, ...evidence }, request.summary, 'refused'),
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
            'The Person has not allowed Vivid to use their computer. While its Vivid desktop app is open, they are asked over the message box: tell them to press Allow there, then try again.',
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
      Effect.succeed(CallOutcome.cases.Unknown.make({ summary: request.summary, receipt: null })),
  })
})

/** Only these four tools exist. Payload ownership fields are excess properties and rejected at ingress. */
const dispatch = Effect.fn('Code.dispatch')(function* (
  boundary: CodeBoundary,
  call: typeof WorkerMessage.cases.Call.Type,
  policy: DisplayCallPolicy,
) {
  const actor = yield* (yield* CodeAuthority).refresh(boundary)
  switch (call.kind) {
    case 'find_tools': {
      const request = yield* decodeFind(call.input, { onExcessProperty: 'error' })
      return returned(toolView(yield* findTools(actor, request)), request.query)
    }
    case 'use_tool':
      return yield* connection(actor, call.input, policy)
    case 'browse': {
      const refusal = displayCallRefusal(policy, 'browser')
      if (Option.isSome(refusal))
        return yield* refused(
          'browse',
          { ok: false, reason: refusal.value },
          'Check browser access',
        )
      return yield* browse(actor, call.input)
    }
    case 'read_page': {
      const refusal = displayCallRefusal(policy, 'page')
      if (Option.isSome(refusal))
        return yield* refused(
          'read_page',
          { ok: false, reason: refusal.value },
          'Check page access',
        )
      const request = yield* decodePage(call.input, { onExcessProperty: 'error' })
      const outcome = yield* readPage(request)
      return ReadPageOutcome.match(outcome, {
        Read: ({ address, title, text: content, truncated }) =>
          returned({ ok: true, address, title, text: content, truncated }, 'Read a public page'),
        Refused: ({ reason }) => {
          if (
            reason === 'needs a browser to show its content' ||
            reason === 'blocked by a bot check'
          )
            return returned(
              {
                ok: false,
                reason,
                next: 'Open the requested address with browse on the Computer.',
              },
              'Read a public page',
              'refused',
            )
          return returned({ ok: false, reason }, 'Read a public page', 'refused')
        },
      })
    }
  }
  // Decoded call kinds are exhaustive; adding one makes this return incompatible with CallOutcome.
  return call.kind
})

export interface CodeCallsService {
  readonly bind: (boundary: CodeBoundary) => Dispatch
  readonly bindQuery: (boundary: CodeBoundary) => Dispatch
}

/** Binding captures trusted services, not guest input. Refresh occurs inside dispatch, after queuing. */
export class CodeCalls extends Context.Service<CodeCalls, CodeCallsService>()('vivid/CodeCalls') {}

export const codeCallsLayer = Layer.effect(
  CodeCalls,
  Effect.gen(function* () {
    // A derived capture silently absorbs new scoped dependencies. Pick only these authorities so
    // future dispatch requirements fail typecheck and the Run's Scope and parent span stay local.
    const context = Context.pick(
      ActionLookup,
      CodeAuthority,
      IntegrationAnswers,
      Gate,
      Executor,
      ExecutorMembers,
      ConnectionStore,
      ToolEffects,
      DecisionModel.DecisionModel,
      DeviceRegistry,
      ComputerStore,
      Database,
      PageReader,
    )(
      yield* Effect.context<
        | ActionLookup
        | CodeAuthority
        | IntegrationAnswers
        | Gate
        | Executor
        | ExecutorMembers
        | ConnectionStore
        | ToolEffects
        | DecisionModel.DecisionModel
        | DeviceRegistry
        | ComputerStore
        | Database
        | PageReader
      >(),
    )
    // Both policies share authority refresh and recovery; only automatic display calls restrict capabilities.
    const bind = (boundary: CodeBoundary, policy: DisplayCallPolicy): Dispatch =>
      Effect.fn('Code.boundCall')((call) =>
        dispatch(boundary, call, policy).pipe(
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
            // Every InvalidRequest is a sentence this server wrote for the caller; the program
            // reads the same reason use_tool or find_tools would give, not a blank refusal.
            InvalidRequest: ({ message }) =>
              refused(call.kind, { ok: false, reason: message }, 'Check the request'),
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
      )
    return CodeCalls.of({
      bind: (boundary) => bind(boundary, DisplayCallPolicy.cases.Press.make({})),
      bindQuery: (boundary) => bind(boundary, DisplayCallPolicy.cases.Draw.make({})),
    })
  }),
)

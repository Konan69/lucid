import { integrationWaitingMessage } from '@vivid/contracts'
import {
  ActionApplied,
  type ActionReceipt,
  BrowseOutcome,
  DesktopOutcome,
  ToolOutcome,
  type IntegrationResult,
  WindowOutcome,
  WindowResult,
  type WindowView,
  type WindowRefusal,
} from '@vivid/contracts'
import * as views from './views.ts'
import type { ToolResult } from './result.ts'

/** Approval is a real stop: the server already asked the person and will resume after their decision. */
function approval({
  approvalId,
  summary,
}: {
  readonly approvalId: string
  readonly summary: string
}): ToolResult {
  return {
    output: views.approval({ approvalId, summary }),
    terminate: true,
  }
}

/** A rule is authoritative, so the model receives its exact wording rather than a retry suggestion. */
function blocked({ rule }: { readonly rule: string }): ToolResult {
  return {
    output: {
      ok: false,
      rule: views.modelText(rule),
      message: views.modelText(`A rule forbids this action: “${rule}”.`),
    },
  }
}

/** Computer availability is distinct from policy and never grants permission to bypass it. */
function unavailable({ reason }: { readonly reason: string }): ToolResult {
  return {
    output: {
      ok: false,
      reason: views.modelText(reason),
      message: views.modelText(`The Computer is unavailable: ${reason}.`),
    },
  }
}

/** A lost receipt preserves uncertainty and never turns a possible side effect into retry permission. */
function outcomeUnknown(): ToolResult {
  return {
    output: {
      ok: false,
      message: 'The action may or may not have happened; do not retry without asking the person.',
    },
  }
}

/**
 * A journaled write whose answer was lost. Its receipt stays in metadata for reconciliation; the
 * model is told what that means and the action path ends, as an unknown program call ends its
 * program. Sending it again is refused by the server until the operation is reconciled.
 */
function writeUnknown(receipt: ActionReceipt): ToolResult {
  return {
    output: {
      ok: false,
      message:
        'The action was sent and its answer was lost, so it may or may not have happened. Do not send it again; tell the Person its result is not known yet.',
    },
    terminate: true,
    receipts: [receipt],
  }
}

/** What each applied receipt proves, in the words the model reports to the Person. */
const appliedWords = (receipt: ActionApplied) =>
  ActionApplied.match(receipt, {
    Accepted: () => 'The service accepted the action; it is queued, not confirmed yet.',
    Completed: () => 'The service answered that the action is done.',
    Delivered: () => 'The service answered that the action is done and confirmed it arrived.',
  })

/** Provider records pass through untouched; settle bounds them without removing provider authority.
 * Each service outcome gives one truthful next step; an unknown side effect must never be retried blindly. */
export function toolOutcome(result: IntegrationResult): ToolResult {
  const projected = ToolOutcome.match<ToolResult>(result.outcome, {
    Accepted: ({ output, receipt }) => ({
      output: {
        ok: true,
        output,
        message: 'The service accepted the action; it is queued, not confirmed yet.',
      },
      receipts: receipt === null ? [] : [receipt],
    }),
    Completed: ({ output, receipt }) =>
      receipt === null
        ? { output: { ok: true, output, message: 'The action completed.' } }
        : { output: { ok: true, output, message: appliedWords(receipt) }, receipts: [receipt] },
    Repeated: ({ receipt }) => ({
      output: {
        ok: true,
        message: `This exact action was already sent, so it was not sent again. ${appliedWords(receipt)} Its earlier answer is not available here.`,
      },
      receipts: [receipt],
    }),
    InputRequired: ({ requestId, questions }) => ({
      output: { kind: 'input-request', requestId, questions, message: integrationWaitingMessage },
      terminate: true,
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    ScopeRequired: ({ required, granted }) => ({
      output: {
        ok: false,
        required,
        granted,
        message: 'This operation requires additional access. Do not substitute another account.',
      },
    }),
    PermissionDeclined: ({ classes }) => ({
      output: {
        ok: false,
        classes,
        message:
          'The person has not allowed access to these data classes. Do not try another tool to bypass this decision.',
      },
    }),
    Unsupported: ({ capability }) => ({
      output: {
        ok: false,
        capability,
        message: 'This Integration does not support this capability.',
      },
    }),
    ConnectionNotReady: ({ serviceName, grant }) => ({
      output: {
        ok: false,
        serviceName: views.modelText(serviceName),
        grant,
        message: views.modelText(
          `${serviceName} needs connecting; offer it to the person with connect.`,
        ),
      },
    }),
    Rejected: ({ message, problems }) => ({
      output: {
        ok: false,
        message: views.modelText(`The service rejected the action: ${message}.`),
        problems: problems.map(views.modelText),
      },
    }),
    OutcomeUnknown: ({ receipt }) => (receipt === null ? outcomeUnknown() : writeUnknown(receipt)),
  })
  return { ...projected, integration: result }
}

/** Browser results keep the page outline and authorization decisions supplied by the server. */
export function browseOutcome(outcome: BrowseOutcome): ToolResult {
  return BrowseOutcome.match<ToolResult>(outcome, {
    NotConnected: () => ({
      output: {
        ok: false,
        message: 'The Person’s desktop app is not connected. Ask them to connect it.',
      },
    }),
    AddressRefused: () => ({
      output: {
        ok: false,
        message:
          'That page or address cannot be opened on the Person’s computer. Use a public web address.',
      },
    }),
    NotAllowed: () => ({
      output: {
        ok: false,
        message:
          'The Person has not allowed Vivid to use their computer. While its Vivid desktop app is open, they are asked over the message box: tell them to press Allow there, then try again.',
      },
    }),
    Busy: () => ({
      output: {
        ok: false,
        message: 'The Person’s computer is busy with an earlier action. Wait for it to finish.',
      },
    }),
    Stopped: () => ({
      output: {
        ok: false,
        message: 'The Person took control of the page. Stop and do not retry by yourself.',
      },
      terminate: true,
    }),
    PageGone: () => ({
      output: { ok: false, message: 'The page is gone. Ask the Person to open it again.' },
    }),
    Unsupported: () => ({
      output: {
        ok: false,
        message:
          'The Person’s computer does not support this browser action. Ask the Person to do it.',
      },
    }),
    RunRequired: () => ({
      output: {
        ok: false,
        message:
          'Nothing was sent, because the work that asked for it has ended. Ask the Person before trying again.',
      },
      terminate: true,
    }),
    Completed: ({ result }) => ({
      output: { ok: true, result: views.browse(result), message: 'The browser action completed.' },
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    Unavailable: unavailable,
    OutcomeUnknown: outcomeUnknown,
  })
}

/** Picture bytes use image content rather than bounded JSON text or invented URLs. */
export function desktopOutcome(outcome: DesktopOutcome): ToolResult {
  return DesktopOutcome.match(outcome, {
    Completed: ({ view }) => ({
      output: {
        ok: true,
        view: views.desktop(view),
        message: 'The desktop action completed; verify the picture.',
      },
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    Unavailable: unavailable,
    OutcomeUnknown: outcomeUnknown,
  })
}

/** Every native refusal gives a distinct fixed next step; Stop is a termination, never a retry. */
const windowRefusals = {
  Stopped: 'The person stopped Vivid on their computer. Stop and do not retry.',
  Elevated:
    'Windows does not let Vivid type into an administrator window. Ask the person to do that step.',
  WindowGone: 'The window is gone. List the windows again.',
  LookStale: 'This look is stale. Look at the window again before acting.',
  NotInFront: 'Windows would not bring this window forward. Ask the person to bring it forward.',
  Unsupported: 'This computer cannot do that action. Ask the person to do it.',
} satisfies Record<WindowRefusal, string>

/** Only text metadata belongs in JSON; the same native image adapter carries the window picture. */
const windowView = ({ window, app, look, width, height, outline, truncated }: WindowView) => ({
  window,
  app,
  look,
  width,
  height,
  outline: views.modelText(outline),
  truncated,
})

/** Inventories are compact text with IDs; every observed window retains its look ID and outline. */
const windowResult = (result: WindowResult) =>
  WindowResult.match<ToolResult>(result, {
    Apps: ({ apps, skipped }) => ({
      output: {
        ok: true,
        apps: apps.map(({ id, name }) => `${id}: ${name}`).join('\n'),
        skipped,
        message: 'The installed apps are listed.',
      },
    }),
    Windows: ({ windows }) => ({
      output: {
        ok: true,
        windows: windows.map(({ id, app, title }) => `${id}: ${app} — ${title}`).join('\n'),
        message: 'The open windows are listed.',
      },
    }),
    Seen: ({ view }) => ({
      output: {
        ok: true,
        view: windowView(view),
        message: 'Verify the window picture and outline before acting.',
      },
    }),
    Typed: ({ view, complete, sent }) => ({
      output: {
        ok: true,
        view: windowView(view),
        complete,
        sent,
        message: complete
          ? 'The text was typed; verify the window.'
          : 'Typing stopped partway through. Do not type the delivered characters again.',
      },
    }),
    Closed: () => ({ output: { ok: true, message: 'The window closed.' } }),
    Closing: ({ view }) => ({
      output: {
        ok: true,
        view: windowView(view),
        message: 'The app is asking a question before closing. Inspect it and answer or leave it.',
      },
    }),
  })

/** Native availability, refusal and uncertainty remain separate outcomes for the model. */
export function windowOutcome(outcome: WindowOutcome): ToolResult {
  return WindowOutcome.match<ToolResult>(outcome, {
    Completed: ({ result }) => windowResult(result),
    Refused: ({ reason }) => ({
      output: { ok: false, reason, message: windowRefusals[reason] },
      terminate: reason === 'Stopped',
    }),
    NotConnected: () => ({
      output: {
        ok: false,
        message: 'The person’s desktop app is not connected. Ask them to connect it.',
      },
    }),
    Busy: () => ({
      output: {
        ok: false,
        message: 'The person’s computer is busy with an earlier action. Wait for it to finish.',
      },
    }),
    RunRequired: () => ({
      output: {
        ok: false,
        message:
          'Nothing was sent because the Run that asked has ended. Stop and ask the person before trying again.',
      },
      terminate: true,
    }),
    Unavailable: ({ reason }) => ({
      output: {
        ok: false,
        reason: views.modelText(reason),
        message: `Apps are unavailable on the person’s computer: ${views.modelText(reason)}`,
      },
    }),
    OutcomeUnknown: outcomeUnknown,
  })
}

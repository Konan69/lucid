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
import { plain, quiet, refused, translate, type Plain } from './views.ts'
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

/**
 * A rule is authoritative, so the model receives its exact wording rather than a retry suggestion.
 * The rule is one the Person (or their Company) wrote, so the Person hears that it was their rule
 * that stopped it, not that "a rule forbids this action".
 */
function blocked({ rule }: { readonly rule: string }): ToolResult {
  return {
    output: {
      ...refused(
        `A rule forbids this action: “${rule}”.`,
        plain(`that goes against one of your rules (“${rule}”), so i didn’t do it.`),
      ),
      rule: views.modelText(rule),
    },
  }
}

/** Computer availability is distinct from policy and never grants permission to bypass it. */
function unavailable({ reason }: { readonly reason: string }): ToolResult {
  return {
    output: {
      ...refused(
        `The Computer is unavailable: ${reason}.`,
        plain('my computer isn’t working right now, so i couldn’t do that.'),
      ),
      reason: views.modelText(reason),
    },
  }
}

/**
 * Whether something may have happened, for the Person: nothing is retried until it is checked, so
 * the sentence says only that it is not known and that it was not done twice.
 */
const unsure = plain('i can’t tell yet whether that went through, so i haven’t done it again.')

/** A lost receipt preserves uncertainty and never turns a possible side effect into retry permission. */
function outcomeUnknown(): ToolResult {
  return {
    output: refused(
      'The action may or may not have happened; do not retry without asking the person.',
      unsure,
    ),
  }
}

/**
 * A journaled write whose answer was lost. Its receipt stays in metadata for reconciliation; the
 * model is told what that means and the action path ends, as an unknown program call ends its
 * program. Sending it again is refused by the server until the operation is reconciled.
 */
function writeUnknown(receipt: ActionReceipt): ToolResult {
  return {
    output: refused(
      'The action was sent and its answer was lost, so it may or may not have happened. Do not send it again; tell the Person its result is not known yet.',
      unsure,
    ),
    terminate: true,
    receipts: [receipt],
  }
}

/**
 * What each applied receipt proves, in words the model can repeat to the Person as they are:
 * "accepted" and "queued" are the service's states, and replies that echoed them ("it's queued")
 * told the Person nothing they could use. Each sentence still says exactly how far it got.
 */
const accepted = 'It is on its way: the service took it but has not confirmed it is done yet.'
const appliedWords = (receipt: ActionApplied) =>
  ActionApplied.match(receipt, {
    Accepted: () => accepted,
    Completed: () => 'It is done: the service said it did it.',
    Delivered: () => 'It is done, and the service confirmed it arrived.',
  })

/** Provider records pass through untouched; settle bounds them without removing provider authority.
 * Each service outcome gives one truthful next step; an unknown side effect must never be retried blindly. */
export function toolOutcome(result: IntegrationResult): ToolResult {
  const projected = ToolOutcome.match(result.outcome, {
    Accepted: ({ output, receipt }) => ({
      output: {
        ok: true,
        output,
        message: accepted,
      },
      receipts: receipt === null ? [] : [receipt],
    }),
    Completed: ({ output, receipt }) =>
      receipt === null
        ? { output: { ok: true, output, message: 'It is done.' } }
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
    // Each refusal says, for the Person, what did not happen and the one thing that changes it.
    // A rejection is worded by the service (usually about the call's input, which Vivid corrects),
    // so its meaning is left to the model to translate.
    ScopeRequired: ({ required, granted }) => ({
      output: {
        ...refused(
          'This operation requires additional access. Do not substitute another account.',
          plain(
            'that account hasn’t given me access to do that. signing in to it again and allowing it would.',
          ),
        ),
        required,
        granted,
      },
    }),
    PermissionDeclined: ({ classes }) => ({
      output: {
        ...refused(
          'The person has not allowed access to these data classes. Do not try another tool to bypass this decision.',
          plain('you haven’t let me see that kind of information, so i left it alone.'),
        ),
        classes,
      },
    }),
    Unsupported: ({ capability }) => ({
      output: {
        ...refused(
          'This Integration does not support this capability.',
          plain('i can’t do that through that account.'),
        ),
        capability,
      },
    }),
    ConnectionNotReady: ({ serviceName, grant }) => ({
      output: {
        ...refused(
          `${serviceName} needs connecting; offer it to the person with connect.`,
          plain(`i can’t get into your ${serviceName} yet. it needs connecting first.`),
        ),
        serviceName: views.modelText(serviceName),
        grant,
      },
    }),
    Rejected: ({ message, problems }) => ({
      output: {
        ...refused(`The service rejected the action: ${message}.`, translate),
        problems: problems.map(views.modelText),
      },
    }),
    OutcomeUnknown: ({ receipt }) => (receipt === null ? outcomeUnknown() : writeUnknown(receipt)),
  })
  return { ...projected, integration: result }
}

/**
 * What the Person hears when their own computer cannot be used: the desktop app is the thing they
 * open, so the sentence names it and nothing about connections or devices.
 */
const notConnected = plain(
  'your computer isn’t connected to me right now. open the vivid app on it and ask me again.',
)
/** An earlier step is still running; Vivid waits for it, and the Person has nothing to do. */
const busy = quiet

/** Browser results keep the page outline and authorization decisions supplied by the server. */
export function browseOutcome(outcome: BrowseOutcome): ToolResult {
  return BrowseOutcome.match(outcome, {
    NotConnected: () => ({
      output: refused(
        'The Person’s desktop app is not connected. Ask them to connect it.',
        notConnected,
      ),
    }),
    AddressRefused: () => ({
      output: refused(
        'That page or address cannot be opened on the Person’s computer. Use a public web address.',
        plain('i can’t open that address on your computer.'),
      ),
    }),
    NotAllowed: () => ({
      output: refused(
        'The Person has not allowed Vivid to use their computer. While its Vivid desktop app is open, they are asked over the message box: tell them to press Allow there, then try again.',
        plain(
          'i need your ok to use your computer. press allow in the vivid app on it, then ask me again.',
        ),
      ),
    }),
    Busy: () => ({
      output: refused(
        'The Person’s computer is busy with an earlier action. Wait for it to finish.',
        busy,
      ),
    }),
    Stopped: () => ({
      output: refused(
        'The Person took control of the page. Stop and do not retry by yourself.',
        plain('you took over, so i’ve stopped there.'),
      ),
      terminate: true,
    }),
    PageGone: () => ({
      output: refused(
        'The page is gone. Ask the Person to open it again.',
        plain('that page closed. open it again and tell me when it’s there.'),
      ),
    }),
    Unsupported: () => ({
      output: refused(
        'The Person’s computer does not support this browser action. Ask the Person to do it.',
        plain('i can’t do that step on your computer. could you do that bit yourself?'),
      ),
    }),
    RunRequired: () => ({
      output: refused(
        'Nothing was sent, because the work that asked for it has ended. Ask the Person before trying again.',
        quiet,
      ),
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

/**
 * Every native refusal gives a distinct fixed next step for Vivid, and what it means for the
 * Person; Stop is a termination, never a retry. A gone window or a stale look is Vivid's to fix.
 */
const windowRefusals = {
  Stopped: {
    message: 'The person stopped Vivid on their computer. Stop and do not retry.',
    tellThem: plain('you stopped me, so i’ve left it there.'),
  },
  Elevated: {
    message:
      'Windows does not let Vivid type into an administrator window. Ask the person to do that step.',
    tellThem: plain(
      'that window needs admin rights, so i can’t type into it. could you do that step?',
    ),
  },
  WindowGone: { message: 'The window is gone. List the windows again.', tellThem: quiet },
  LookStale: {
    message: 'This look is stale. Look at the window again before acting.',
    tellThem: quiet,
  },
  NotInFront: {
    message: 'Windows would not bring this window forward. Ask the person to bring it forward.',
    tellThem: plain('i couldn’t bring that window to the front. could you click on it for me?'),
  },
  Unsupported: {
    message: 'This computer cannot do that action. Ask the person to do it.',
    tellThem: plain('i can’t do that step on your computer. could you do that bit yourself?'),
  },
} satisfies Record<WindowRefusal, { readonly message: string; readonly tellThem: Plain }>

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
  WindowResult.match(result, {
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
  return WindowOutcome.match(outcome, {
    Completed: ({ result }) => windowResult(result),
    Refused: ({ reason }) => ({
      output: {
        ...refused(windowRefusals[reason].message, windowRefusals[reason].tellThem),
        reason,
      },
      terminate: reason === 'Stopped',
    }),
    NotConnected: () => ({
      output: refused(
        'The person’s desktop app is not connected. Ask them to connect it.',
        notConnected,
      ),
    }),
    Busy: () => ({
      output: refused(
        'The person’s computer is busy with an earlier action. Wait for it to finish.',
        busy,
      ),
    }),
    RunRequired: () => ({
      output: refused(
        'Nothing was sent because the Run that asked has ended. Stop and ask the person before trying again.',
        quiet,
      ),
      terminate: true,
    }),
    Unavailable: ({ reason }) => ({
      output: {
        ...refused(
          `Apps are unavailable on the person’s computer: ${reason}`,
          plain('i can’t use the apps on your computer right now.'),
        ),
        reason: views.modelText(reason),
      },
    }),
    OutcomeUnknown: outcomeUnknown,
  })
}

import { BrowseOutcome, CommandOutcome, DesktopOutcome, ToolOutcome } from '@vivid/contracts'
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

/** Provider records pass through untouched; settle bounds them without removing provider authority.
 * Each service outcome gives one truthful next step; an unknown side effect must never be retried blindly. */
export function toolOutcome(outcome: ToolOutcome): ToolResult {
  return ToolOutcome.match(outcome, {
    Completed: ({ output }) => ({
      output: { ok: true, output, message: 'The action completed.' },
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    ConnectionNotReady: ({ serviceName }) => ({
      output: {
        ok: false,
        serviceName: views.modelText(serviceName),
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
    OutcomeUnknown: outcomeUnknown,
  })
}

/** Commands share the approval policy but preserve exit status and the server's truncation marker. */
export function commandOutcome(outcome: CommandOutcome): ToolResult {
  return CommandOutcome.match(outcome, {
    Completed: ({ result }) => ({
      output: {
        ok: true,
        result: views.command(result),
        message: 'The command completed; check its exit code.',
      },
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    Unavailable: unavailable,
    OutcomeUnknown: outcomeUnknown,
  })
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
          'The Person has not allowed access to their computer. Ask them to allow it in the desktop app.',
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

/** Picture bytes use Flue's image content, never bounded JSON text or an invented file URL. */
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

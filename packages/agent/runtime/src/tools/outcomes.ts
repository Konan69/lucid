import { BrowseOutcome, CommandOutcome, ToolOutcome } from '@vivid/contracts'
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

/** Each service outcome gives one truthful next step; an unknown side effect must never be retried blindly. */
export function toolOutcome(outcome: ToolOutcome): ToolResult {
  return ToolOutcome.match(outcome, {
    Completed: ({ output }) => ({
      output: { ok: true, output: views.external(output), message: 'The action completed.' },
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
    Rejected: ({ message }) => ({
      output: {
        ok: false,
        message: views.modelText(`The service rejected the action: ${message}.`),
      },
    }),
    OutcomeUnknown: () => ({
      output: {
        ok: false,
        message: 'The action may or may not have happened; do not retry without asking the person.',
      },
    }),
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
  })
}

/** Browser results keep the page outline and authorization decisions supplied by the server. */
export function browseOutcome(outcome: BrowseOutcome): ToolResult {
  return BrowseOutcome.match(outcome, {
    Completed: ({ result }) => ({
      output: { ok: true, result: views.browse(result), message: 'The browser action completed.' },
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    Unavailable: unavailable,
  })
}

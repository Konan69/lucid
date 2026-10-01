import { BrowseOutcome, CommandOutcome, ToolOutcome } from '@vivid/contracts'
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
    output: {
      kind: 'approval-request',
      approvalId,
      summary,
      message: 'Stop and wait; the person has been asked to approve this action.',
    },
    terminate: true,
  }
}

/** A rule is authoritative, so the model receives its exact wording rather than a retry suggestion. */
function blocked({ rule }: { readonly rule: string }): ToolResult {
  return { output: { ok: false, rule, message: `A rule forbids this action: “${rule}”.` } }
}

/** Computer availability is distinct from policy and never grants permission to bypass it. */
function unavailable({ reason }: { readonly reason: string }): ToolResult {
  return { output: { ok: false, reason, message: `The Computer is unavailable: ${reason}.` } }
}

/** Each service outcome gives one truthful next step; an unknown side effect must never be retried blindly. */
export function toolOutcome(outcome: ToolOutcome): ToolResult {
  return ToolOutcome.match(outcome, {
    Completed: ({ output }) => ({ output: { ok: true, output, message: 'The action completed.' } }),
    ApprovalRequired: approval,
    Blocked: blocked,
    ConnectionNotReady: ({ service, serviceName }) => ({
      output: {
        ok: false,
        service,
        serviceName,
        message: `${serviceName} needs connecting; offer it to the person with connect.`,
      },
    }),
    Rejected: ({ message }) => ({
      output: { ok: false, message: `The service rejected the action: ${message}.` },
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
      output: { ok: true, result, message: 'The command completed; check its exit code.' },
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
      output: { ok: true, result, message: 'The browser action completed.' },
    }),
    ApprovalRequired: approval,
    Blocked: blocked,
    Unavailable: unavailable,
  })
}

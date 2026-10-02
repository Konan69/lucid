import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: false,
  name: 'Chase an outcome',
  about:
    'Tracks your commitment, follows up on progress, and checks the evidence before calling it done.',
  useWhen: 'When a commitment needs an owner, follow-up and evidence of completion.',
  needs: [
    'create_task',
    'update_task',
    'list_tasks',
    'schedule_follow_up',
    'find_tools',
    'use_tool',
    'connect',
    'ask_person',
  ],
  connections: [['Gmail', 'Outlook', 'Microsoft Outlook', 'Slack', 'Linear', 'Asana']],
  instructions: `Turn the request into a concrete outcome: what must exist, who owns it, when it is needed and what evidence will prove completion. Ask with \`ask_person\` if ownership or the success condition is unclear. Use \`list_tasks\` to find existing tracked work before creating a duplicate. Create a Task only for the agreed commitment, with a specific title and an honest assignee.

Discover the connected mail or work tools with \`find_tools\`. If the integration needed to check progress is not connected, offer \`connect\`; track only what the Person has supplied until access exists. Read current status and relevant conversations with \`use_tool\`. Separate progress, a promise and a completed deliverable. Do not treat a status label alone as proof that the expected result exists.

Agree a useful next check and use \`schedule_follow_up\` with a clear note about what to verify. Keep the timing within the Person's stated preferences. At a check, inspect fresh evidence and report what changed, what is blocked and the next decision. A reminder to the Person is different from a message to an outsider. External follow-up messages need exact recipients and content and the normal permission and Approval.

Use \`update_task\` when verified progress changes the commitment. Mark it complete only after the agreed success condition is met, and verify that completion ends the pending follow-ups. Report the evidence in the Thread. If the deadline slips or the result remains uncertain, state that plainly and ask for a revised plan instead of scheduling an endless series of nudges.`,
})

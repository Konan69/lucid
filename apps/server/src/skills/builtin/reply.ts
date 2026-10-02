import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: false,
  name: 'Draft a reply',
  about: 'Drafts a considered reply in your voice for you to review.',
  useWhen: 'When a connected conversation needs a considered reply for review.',
  needs: ['find_tools', 'use_tool', 'connect', 'search_library', 'recall', 'ask_person'],
  connections: [['Gmail', 'Outlook', 'Microsoft Outlook']],
  instructions: `Read the whole supplied conversation before writing. If it is in an external account, discover its read tool with \`find_tools\`; if the integration is not connected, offer \`connect\` or work from text the Person supplies. Check the sender, recipients, latest unanswered request and any referenced attachment. Ask for missing material rather than pretending to have read it.

Use \`recall\` for tone and relationship preferences and \`search_library\` for facts the reply needs. Verify prices, deadlines and promises from current evidence. Identify what the Person can commit to and what still needs their decision. Use \`ask_person\` for a material missing answer; avoid interrupting for details that can be left visibly unresolved in a draft.

Write a concise reply that answers the actual request, puts the next step plainly and uses the Person's preferred tone. Distinguish confirmed facts from proposed commitments. Do not invent availability, agreement, an attachment or a prior conversation. Include the intended recipients and subject with the draft so review covers the whole action. If a service supports saving drafts, saving there is still an external write and follows its permission check.

Return the text in the Thread for review. A completed draft is not a sent message. Sending requires authorization for the exact recipients, body and attachments through the normal Approval path. After an authorized send, inspect the service's confirmation before saying it was sent. If the confirmation is uncertain, say so and do not resend automatically.`,
})

import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: false,
  name: 'Work in a signed-in browser',
  useWhen: 'When work requires an interactive page or an existing browser session.',
  needs: ['browse', 'use_desktop', 'ask_person', 'find_tools', 'connect'],
  connections: [],
  instructions: `Identify the site, account and intended result before interacting. Prefer a connected service when it provides the needed operation: use \`find_tools\` and, if the required integration is not connected, offer \`connect\`. Use the Computer's existing browser for work that requires a page. Its profile may already be signed in; do not create a fresh profile or assume an earlier session still works.

Use \`browse\` to open the intended address and read fresh page state. Confirm the visible account and inspect the page before clicking. Use \`use_desktop\` when a page cannot be operated through the browser's named targets. After navigation, submission or a dialog change, look again; targets and screen coordinates from an older view may be stale.

If the Person is holding the keyboard, stop issuing input. For sign-in, a challenge or a verification prompt, use \`ask_person\` to explain what they must finish on the Computer. Never request passwords or verification codes in the Thread. Continue only after they return control, then inspect fresh state. If the provider is unavailable or startup fails, describe that outcome without repeatedly restarting.

Before a consequential submission, show the exact recipient, content and consequence and wait for the required Approval. Do not retry a submission with an uncertain result. Verify the site's confirmation and, where possible, read back the resulting record. Report what was confirmed and what remains unresolved; an input step completing alone is not proof that the work succeeded.`,
})

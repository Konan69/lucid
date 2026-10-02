import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: true,
  name: 'Connect a service',
  about: 'Connects the services you need so your work can move forward.',
  useWhen: 'When a request needs access to an external account.',
  needs: [
    'find_integrations',
    'find_tools',
    'connect',
    'add_integration',
    'test_integration',
    'ask_person',
  ],
  connections: [],
  instructions: `Start with the work the Person wants finished. Identify the smallest service and account needed, and whether the work only reads or also changes something. Use \`find_tools\` to check existing Connections before offering another one. A listed service is not proof that its account is connected.

Use \`find_integrations\` to find the service by its real name. If it is not connected, offer \`connect\` and explain what access makes possible. If the service is missing from the catalogue, ask for its published integration address and use \`add_integration\` only with a supported address. Do not invent an address or claim unsupported setup worked. If installation setup is required, explain that dependency and stop there.

Let the Person complete sign-in or enter a key through the secure Connection card. Never ask them to paste a password, key or sign-in code into the Thread. Do not keep requesting access while sign-in is pending. Once connected, use \`test_integration\` and discover the needed tool again. Verify one narrow read through the connected account before continuing the original request.

Report the account tested and the work that can now continue. Setup is done only when access and the read succeed. Ask with \`ask_person\` if account choice or sharing is unclear. Company sharing needs explicit intent and permission; sending, deleting or changing external records still follows the exact action's Approval.`,
})

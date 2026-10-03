import { Procedure } from './procedure.ts'

/**
 * Adapted from Muse's shipped procedure, read in full at
 * `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/shopping/SKILL.md`.
 * Kept: resolve the attributes that decide correctness first, verify each product page, present
 * once and keep purchase separate. Muse's catalogue and citation-marker plumbing is dropped.
 */
export const procedure = Procedure.make({
  starter: false,
  name: 'Shop for something',
  about:
    'Finds well-priced products that match what you asked for and checks each one is really available.',
  useWhen: 'When the Person wants products found, compared, a deal located or a purchase made.',
  needs: [
    'find_tools',
    'use_tool',
    'connect',
    'read_page',
    'browse',
    'recall',
    'show',
    'ask_person',
  ],
  connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  instructions: `Aim to save the Person money: find good-quality, fairly priced products that match every constraint they gave. Check \`recall\` for standing preferences and sizes first.

Some constraints decide which products are correct rather than how they rank: the wearer's size and cut for clothing, the exact device or vehicle a part must fit, the platform for software. Resolve each from the request, the conversation and memory before searching. If one is still unknown, ask with \`ask_person\`, one question at a time, starting with the one that most changes the results. Never guess who will wear it or transfer one brand's size to another. A stored size settles it only when the Person is the wearer.

Use \`find_tools\` to discover a connected search tool, run it with \`use_tool\`, and offer \`connect\` if none is ready. Learn the typical price and well-known sellers for the category, then search with every constraint in the query. Open each candidate with \`read_page\`, or \`browse\` for an interactive page, and drop anything that is not a product page, is out of stock, misses a constraint or sits far outside the normal price range. Prefer sellers that serve the Person's country. If too few remain, adjust the query and search again. For a deal, establish the baseline price, look for lower listings and published promotion codes, and say plainly when no current deal exists.

Present once, after the searches finish, using \`show\` for a comparison ranked best first. Lead with one takeaway and the decisive trade-off. Name only products from a page you read, with the address and price seen. Mark an early update as early and make no best-of claim in it. Keep the original constraints through follow-ups unless the Person drops them.

Buying is separate. Confirm the exact item, variant, quantity, seller, delivery and total, then check out in the Computer's browser only after the Approval for that exact purchase. Never ask for card details or passwords in the Thread. Report an order only after the seller's confirmation page.`,
})

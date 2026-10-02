import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: true,
  name: 'Watch a useful signal',
  useWhen: 'When a public page should be checked on an agreed schedule for a meaningful change.',
  needs: [
    'create_routine',
    'list_routines',
    'read_page',
    'recall',
    'remember',
    'correct',
    'ask_person',
    'find_tools',
    'connect',
  ],
  connections: [],
  instructions: `Agree the exact public page, the part to watch, what counts as a useful change and how often to check it. Examples are a named release becoming available or a published date changing. Read the page with \`read_page\` and inspect the relevant content before offering the watch. Ignore menus, advertisements and unrelated timestamps. If the source instead needs a signed-in integration, discover it with \`find_tools\` and offer \`connect\` when missing; do not claim a public-page watch can read private data.

Record a compact initial observation with its source and observed date through \`remember\`, after the Person agrees to retaining that baseline. Use a precise memory description so \`recall\` can find it on later checks. Do not store secrets or an entire page. Ask with \`ask_person\` for the cadence and timezone and inspect \`list_routines\` for an existing watch.

Use \`create_routine\` for the agreed schedule. Its prompt must read the same page, recall the baseline, compare only the agreed signal and return without a notification when unchanged. On a meaningful change, report the old and new observation with the source, then use \`correct\` to replace the baseline. If no baseline can be read, ask for reconciliation instead of announcing a change. A failed read is not a change.

Verify the returned schedule and explain that this is a scheduled comparison, not an instant event subscription. Creating it does not prove any future check succeeded. Publishing or sending a report outside the Routine's Thread requires its own Approval. Do not promise exact-once alerts across interrupted Runs; unresolved baseline updates must be visible.`,
})

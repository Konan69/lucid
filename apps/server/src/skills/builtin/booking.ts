import { Procedure } from './procedure.ts'

/**
 * Adapted from Muse's shipped procedure, read in full at
 * `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/booking/SKILL.md`.
 * Kept: discover before asking, try each path in order, final review on exact terms and success
 * only on the provider's confirmation. Its phone path and category references are dropped.
 */
export const procedure = Procedure.make({
  starter: false,
  name: 'Make a booking',
  about: 'Reserves a flight, hotel, table or ticket for you, and confirms the exact terms with you first.',
  useWhen: 'When the Person wants live availability checked or a flight, hotel, table or ticket booked.',
  needs: [
    'find_tools',
    'use_tool',
    'connect',
    'browse',
    'use_desktop',
    'recall',
    'remember',
    'show',
    'ask_person',
  ],
  connections: [],
  instructions: `Turn a direct request to reserve a flight, hotel, restaurant table or event ticket into a verified booking with as little work from the Person as possible. It needs intent to transact; trip design, inspiration and factual questions such as opening hours or flight status belong elsewhere.

Discover before asking. Resolve relative dates into exact local dates, then check \`recall\` for booking preferences and use \`find_tools\` for connected mail, calendar and booking accounts: past confirmations, memberships, credits and calendar conflicts. Read narrowly; do not browse unrelated mail. Search as soon as a useful search can run and label reversible assumptions. Ask with \`ask_person\` only when a missing fact would produce a materially different search or risks booking the wrong thing, one question at a time. Never invent legal names, ages, identity numbers, dietary needs or payment details.

Search the best available path in order: a connected provider through \`use_tool\`, the provider's own site in the Computer's signed-in browser with \`browse\` and \`use_desktop\`, then a reputable marketplace. If a relevant integration is missing, offer \`connect\` once and keep going without it. When one path has no match, try the next before declaring it unavailable. Never silently substitute a different date, airport, property, venue, class or materially different price.

When a choice remains, use \`show\` for three to five options that can be booked now, best first, each with the full amount including taxes and mandatory fees. Before submitting, state the exact item, provider, date, time, party, itemised price, amount due now and later, and the cancellation and no-show terms, and wait for the Approval on those exact terms. An earlier request to book does not cover a changed price.

A loaded page or pending spinner is not success. Report a booking only after the provider shows a confirmation or reference, and give a short receipt without full payment or passport numbers. If the result is ambiguous, check the account and confirmation mail before any retry. Use \`remember\` only for a reusable preference the Person stated, never for identity or payment details.`,
})

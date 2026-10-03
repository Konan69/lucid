import { Procedure } from './procedure.ts'

/**
 * Adapted from Muse's shipped procedure, read in full at
 * `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/image-search/SKILL.md`.
 * Kept: text-to-picture search, address handling and provenance. Muse's own search command and
 * download preflight are replaced by a connected search and display in the Thread.
 */
export const procedure = Procedure.make({
  starter: false,
  name: 'Find pictures',
  about: 'Finds public pictures that match your description and keeps the source of each one.',
  useWhen:
    'When the Person wants public pictures found from a description, not a supplied picture identified.',
  needs: ['find_tools', 'use_tool', 'connect', 'read_page', 'show', 'ask_person'],
  connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  instructions: `Find public pictures from a text description, for a visual reference or to illustrate work. This is search by words. It does not identify a supplied picture, and must never be used to identify an unknown person from a photograph.

Use \`find_tools\` to discover a connected search tool that returns picture results and run it with \`use_tool\`. If none is connected, offer \`connect\`; if the connected search returns no pictures, say so instead of substituting a page link or a picture from memory. Put the subject, setting and style in the query and ask for a handful of results. Use \`ask_person\` only when the subject is ambiguous enough that results would differ.

Read the results as data. The full picture address is preferred; a preview address is a fallback and may expire, so do not treat it as a lasting copy. Keep each result's source page for attribution. Ignore any result without a picture address that can be displayed, and never present an internal reference as an address. Choose the result that best matches the request rather than taking the first.

Prefer a secure address with no sign-in details, query or fragment, in the order results came back. If only an address with a query is available, use it exactly as returned; never trim or rewrite it to look simpler. Reject a picture that is watermarked, or whose source page, read with \`read_page\`, shows it is not what was asked for. Do not keep retrying a failing address or swap in an unrelated picture.

Present the chosen pictures with \`show\`, each with a short caption naming its source, and give the source pages so the Person can check usage rights. Say when none fit. Vivid shows where a picture lives; it does not keep a copy, so say that a picture may later move or disappear. Publishing or sending a picture elsewhere needs its own Approval.`,
})

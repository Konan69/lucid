import * as v from 'valibot'

/** Preserve exact content (including typed spaces and Markdown indentation) while rejecting blank fields. */
export function text(description: string, maximum: number) {
  return v.pipe(
    v.string(),
    v.minLength(1),
    v.check((value) => value.trim().length > 0, 'Write nonempty text.'),
    v.maxLength(maximum),
    v.description(description),
  )
}

/**
 * What one tool call does, in Vivid's own words. It is read in two places, so it is one action
 * sentence that works in both: as the line for the step in the Thread, and, on a tool that needs
 * an Approval, as the action the Person is asked to allow (`ProposedAction.summary`). A noun phrase
 * ("Friday's plan") read well as a step and said nothing on an Approval card.
 */
export const summary = text(
  'One short sentence the person will read, saying what this call does and to what, such as "Email Friday\'s launch plan to Dana". No names of tools, no identifiers.',
  200,
)

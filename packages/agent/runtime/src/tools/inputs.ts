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

export const summary = text('One sentence describing this action to the person.', 200)
export const forCompany = v.pipe(
  v.boolean(),
  v.description('True only when the person asks to share this with the Company.'),
)

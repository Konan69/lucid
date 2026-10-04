/** Arbitrary tool errors may echo credentials. Only schema-promised safe validation summaries
 * are projected; semantic tool errors retain a constant refusal for both model call paths.
 */
export const toolRejectionMessage =
  'The integration rejected the tool request; sensitive diagnostics were removed.'

/** Ten summaries of at most 400 characters keep a malformed upstream response from consuming
 * the model context while leaving normal field paths readable. These are output limits only.
 */
export const MAX_VALIDATION_PROBLEMS = 10
export const MAX_VALIDATION_PROBLEM_LENGTH = 400

/** SDK implementation/tools.ts runtimeFailure currently emits only the constant "Input did not
 * match the tool schema"; contracts/tools.ts InputInvalid permits richer safe strings later.
 * Tool field names were supplied by the model and need no keyword/length heuristics. Remove
 * only exact known internal reference values, before bounding so no partial reference survives.
 */
export function validationProblems(
  problems: readonly string[],
  internalReferences: readonly string[],
) {
  return problems.slice(0, MAX_VALIDATION_PROBLEMS).map((problem) => {
    const safe = internalReferences.reduce(
      (text, reference) => text.replaceAll(reference, '[REDACTED]'),
      problem,
    )
    return safe.slice(0, MAX_VALIDATION_PROBLEM_LENGTH)
  })
}

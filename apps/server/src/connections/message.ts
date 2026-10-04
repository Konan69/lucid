import { Predicate, type Schema } from 'effect'

/** Tool servers can echo credentials inside arbitrary nested diagnostics. Discard the entire
 * diagnostic when it mentions a credential/header name, so fragmented or quoted values cannot
 * survive partial redaction. Opaque token-shaped runs are removed before the 400-character cut.
 */
export function toolMessage(value: typeof Schema.Json.Type) {
  const text = Predicate.isString(value) ? value : JSON.stringify(value)
  if (
    /\b(?:authorization|bearer|api[-_]?key|token|cookie|secret|password|credential|key)\b/i.test(
      text,
    )
  )
    return 'The integration rejected the tool request; sensitive diagnostics were removed.'
  return text.replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]').slice(0, 400)
}

/** Validation summaries are useful only without credential echoes or foreign identity. SDK
 * InputInvalid promises safe summaries; enforce that promise again at Vivid's model boundary.
 * Discard identity-bearing summaries rather than partially exposing account or internal ids.
 */
export function validationProblem(
  problem: string,
  identity: { readonly app: string; readonly deployment: string },
) {
  if (
    /\b(?:account|profile|deployment|organization|owner|subject|id|identifier)\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
      problem,
    ) ||
    problem.includes(identity.app) ||
    problem.includes(identity.deployment)
  )
    return 'A validation diagnostic containing internal identity was removed.'
  return toolMessage(problem)
}

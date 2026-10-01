import { Predicate, type Schema } from 'effect'

/** Tool servers can echo credentials inside arbitrary nested diagnostics. Discard the entire
 * diagnostic when it mentions a credential/header name, so fragmented or quoted values cannot
 * survive partial redaction; ordinary explanations have a strict 400-character model budget.
 */
export function toolMessage(value: typeof Schema.Json.Type) {
  const text = Predicate.isString(value) ? value : JSON.stringify(value)
  if (/\b(?:authorization|bearer|api[-_]?key|token|cookie)\b/i.test(text))
    return 'The service rejected the tool request; sensitive diagnostics were removed.'
  return text.slice(0, 400)
}

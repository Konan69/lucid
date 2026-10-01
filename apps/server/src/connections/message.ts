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
    return 'The service rejected the tool request; sensitive diagnostics were removed.'
  return text.replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]').slice(0, 400)
}

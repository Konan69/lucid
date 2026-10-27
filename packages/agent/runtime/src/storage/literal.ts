/**
 * A PostgreSQL string literal, as pg 8.23.0's `escapeLiteral` writes it (`lib/utils.js`): quotes
 * and backslashes doubled, and the `E` prefix when a backslash occurs. Ported from the earlier
 * PostgreSQL port; its character-by-character concatenation is replaced by one native
 * replacement, which builds the result in linear space. The caller has already refused raw NUL
 * and checked the connection is UTF8 (`driver.ts`).
 */
export function quoteLiteral(text: string): string {
  const prefix = text.includes('\\') ? " E'" : "'"
  return [prefix, text.replace(/['\\]/gu, '$&$&'), "'"].join('')
}

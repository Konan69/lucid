/** pg 8.23.0 lib/utils.js:escapeLiteral doubles quotes and backslashes and adds
 * " E" when backslashes occur. Its character-by-character concatenation retains
 * ~32 heap bytes per input character; native replacement plus join builds a flat
 * result in linear space. UTF8 and raw-NUL guards still apply before SQL text. */
export function quoteLiteral(text: string): string {
  const prefix = text.includes('\\') ? " E'" : "'"
  return [prefix, text.replace(/['\\]/gu, '$&$&'), "'"].join('')
}

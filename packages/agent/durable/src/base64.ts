import { Option } from 'effect'

/** Decode one ASCII alphabet digit without regex, allocations, or permissive platform coercion. */
function digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (code === 43) return 62
  if (code === 47) return 63
  return -1
}

/**
 * Scan the original data URL from its payload offset. Linear time, constant auxiliary memory:
 * grouped base64 regexes can overflow V8's stack on ordinary photos. Padding occurs only at the
 * end; unused pad bits must be zero. No decoded buffer or payload substring is needed to validate.
 */
export function base64Size(text: string, start: number): Option.Option<number> {
  const length = text.length - start
  if (length === 0 || length % 4 !== 0) return Option.none()
  let end = text.length
  if (text.charCodeAt(end - 1) === 61) end--
  if (text.charCodeAt(end - 1) === 61) end--
  for (let index = start; index < end; index++)
    if (digit(text.charCodeAt(index)) === -1) return Option.none()
  const padding = text.length - end
  const mask = padding === 2 ? 15 : 3
  if (padding > 0 && (digit(text.charCodeAt(end - 1)) & mask) !== 0) return Option.none()
  return Option.some((length / 4) * 3 - padding)
}

/** Decode at most twelve signature bytes from already-validated input, never the whole image. */
export function base64Head(text: string, start: number): readonly number[] {
  const bytes: number[] = []
  let bits = 0
  let buffer = 0
  for (let index = start; index < text.length && bytes.length < 12; index++) {
    const value = digit(text.charCodeAt(index))
    if (value === -1) break // Only terminal padding can remain after base64Size succeeds.
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 255)
    }
  }
  return bytes
}

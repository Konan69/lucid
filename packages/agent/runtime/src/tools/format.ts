import { Option, Result, type Schema } from 'effect'
import { ReadOffsetInvalid } from './failure.ts'
import type { ContentResult } from './tool.ts'
import type { ShellResult } from './sandbox.ts'

/** File tools retain main's text and receipt shape rather than the new SDK's coding vocabulary. */
export function content(text: string, details: Schema.Json): ContentResult {
  return { content: [{ type: 'text', text }], details }
}

/** Main's advertised byte budget actually counts UTF-16 characters; preserve that observable
 * boundary, including the oversized first line and the exact continuation offset. */
export function reading(
  path: string,
  text: string,
  offset: Option.Option<number>,
  limit: Option.Option<number>,
) {
  const from = Option.getOrElse(offset, () => 0)
  const count = Option.getOrElse(limit, () => 0)
  const lines = text.split('\n')
  const start = from ? Math.max(0, from - 1) : 0
  if (start >= lines.length)
    return Result.fail(
      new ReadOffsetInvalid({
        path,
        message: `Offset ${from} is beyond end of file (${lines.length} lines total)`,
      }),
    )
  const selected = lines.slice(start, count ? start + count : lines.length)
  const bounded = head(selected)
  let output = bounded.text
  if (bounded.truncated && bounded.count === 0)
    output += `\n\n[Line ${start + 1} exceeds the 51200-byte read limit; showing the first 51200 bytes of it. The remainder of this line is not accessible via offset/limit.]`
  else if (bounded.truncated)
    output += `\n\n[Showing lines ${start + 1}-${start + bounded.count} of ${lines.length}. Use offset=${start + bounded.count + 1} to continue.]`
  return Result.succeed(content(output, { path, lines: lines.length }))
}

/** Reads keep the head, with a whole-line continuation whenever at least one line fits. */
function head(lines: readonly string[]) {
  let text = ''
  let count = 0
  for (const line of lines) {
    if (count >= 2000) return { text, count, truncated: true }
    const next = count === 0 ? line : `\n${line}`
    if (text.length + next.length > 51200)
      return { text: count === 0 ? line.slice(0, 51200) : text, count, truncated: true }
    text += next
    count += 1
  }
  return { text, count, truncated: false }
}

/** Shell results retain the tail and make a nonzero exit visible without changing error flags. */
export function shell(result: ShellResult, command: string) {
  const joined = (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim()
  const tail = joined.split('\n').slice(-2000).join('\n').slice(-51200)
  const output = tail || '(no output)'
  return content(
    result.exitCode === 0 ? output : `${output}\n\nCommand exited with code ${result.exitCode}`,
    {
      command,
      exitCode: result.exitCode,
    },
  )
}

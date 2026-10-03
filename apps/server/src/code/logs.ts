import type { CodemodeOutputItem } from '@earendil-works/pi-codemode'
import { CodeLogs } from '@vivid/contracts/code'
import { budgets, bytes } from './budgets.ts'

/** Keep a UTF-8 prefix on code-point boundaries, including JSON escaping in the printed-line budget. */
export function encodedPrefix(line: string, maximum: number) {
  let used = 0
  let prefix = ''
  for (const character of line) {
    const size = bytes(JSON.stringify(character)) - 2
    if (used + size > maximum) break
    used += size
    prefix += character
  }
  return prefix
}

/**
 * Pi README/Results and runtime/host.js/Execution preserve ordered text on failures as well.
 * Bound the encoded array to 8 KiB (including empty lines/escaping) before it enters IPC; the
 * enclosing result still counts these bytes within its independent 32 KiB aggregate budget.
 */
export function printed(output: readonly CodemodeOutputItem[]): CodeLogs {
  const lines = output.flatMap((item) => (item.type === 'text' ? [item.text] : []))
  return boundedLogs(lines, budgets.logs, false)
}

/** Keep ordered lines within both their own budget and the final outcome's remaining space. */
export function boundedLogs(
  lines: readonly string[],
  maximum: number,
  alreadyTruncated: boolean,
): CodeLogs {
  const logs: string[] = []
  let used = 2
  for (const text of lines) {
    const overhead = logs.length === 0 ? 2 : 3
    const remaining = maximum - used - overhead
    if (remaining < 0) return CodeLogs.make({ logs, logsTruncated: true })
    const line = encodedPrefix(text, remaining)
    logs.push(line)
    used += bytes(JSON.stringify(line)) + overhead - 2
    if (line !== text) return CodeLogs.make({ logs, logsTruncated: true })
  }
  return CodeLogs.make({ logs, logsTruncated: alreadyTruncated })
}

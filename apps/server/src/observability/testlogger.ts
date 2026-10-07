import { Logger } from 'effect'
import { Message } from './messages.ts'

/** Test-only capture of real Effect log lines like the exporter tests, without replacing the refusal recorder. */
export const refusalLogs = () => {
  const lines: string[] = []
  const capture = Logger.make((entry) => lines.push(Logger.formatSimple.log(entry)))
  return {
    capture,
    layer: Logger.layer([capture], { mergeWithExisting: true }),
    /** Ignore unrelated diagnostics; every refusal must still be exactly one real info line. */
    recorded: () => lines.filter((line) => line.includes(Message.refusal)),
  }
}

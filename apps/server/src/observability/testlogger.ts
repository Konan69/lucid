import { Logger } from 'effect'
import { Message } from './messages.ts'

/** Test-only capture of real Effect log lines like the exporter tests, without replacing the refusal recorder. */
export const decisionLogs = () => {
  const lines: string[] = []
  const capture = Logger.make((entry) => lines.push(Logger.formatSimple.log(entry)))
  return {
    capture,
    layer: Logger.layer([capture], { mergeWithExisting: true }),
    /** Read the real formatted lines with their structured annotations. */
    recorded: () => lines,
  }
}

/** Existing refusal proofs retain their exact filtered view of the shared logger. */
export const refusalLogs = () => {
  const capture = decisionLogs()
  return {
    ...capture,
    recorded: () => capture.recorded().filter((line) => line.includes(Message.refusal)),
  }
}

import type { Phase } from './phase.ts'

/** Names every member: the form the standard asks for. No finding. */
export function label(phase: Phase): string {
  switch (phase) {
    case 'queued':
      return 'Queued'
    case 'working':
      return 'Working'
    case 'done':
      return 'Done'
  }
}

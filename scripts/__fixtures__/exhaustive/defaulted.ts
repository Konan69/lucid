import type { Phase } from './phase.ts'

/** Leaves `done` to a `default`, which would also swallow any member added later. One finding. */
export function label(phase: Phase): string {
  switch (phase) {
    case 'queued':
      return 'Queued'
    case 'working':
      return 'Working'
    default:
      return 'Unknown'
  }
}

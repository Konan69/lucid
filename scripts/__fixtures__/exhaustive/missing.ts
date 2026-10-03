import type { Phase } from './phase.ts'

/** Leaves `done` out. One finding. */
export function label(phase: Phase): string {
  switch (phase) {
    case 'queued':
      return 'Queued'
    case 'working':
      return 'Working'
  }
  return 'Unknown'
}

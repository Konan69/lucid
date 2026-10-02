import type { Approval } from '@vivid/contracts'

/** Every surface names the action's effect identically, independently of its native chip paint. */
export const APPROVAL_EFFECT_WORDS = {
  read: 'Only reads',
  write: 'Changes something',
  destructive: 'Sends, deletes or pays',
} as const satisfies Record<Approval['action']['effect'], string>

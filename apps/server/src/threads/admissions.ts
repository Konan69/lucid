import type { ThreadId } from '@vivid/contracts'
import type { Effect } from 'effect'
import { keyedPermits } from '../runtime/keyed.ts'

const admissions = keyedPermits<ThreadId>()

/** Serialize admission through its Pi receipt with Stop, preserving the caller's resource scope. */
export const withAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>, thread: ThreadId) =>
  admissions.withPermit(thread, effect)

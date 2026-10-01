import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { CompanyId, NotificationKind, PersonId, TaskId, ThreadId } from '@vivid/contracts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/** One thing a Person should be told about. `companyId` is the workspace it happened in. */
export interface Notice {
  readonly personId: PersonId
  readonly companyId: CompanyId | null
  readonly kind: typeof NotificationKind.Type
  readonly title: string
  readonly body: string
  readonly taskId: TaskId | null
  readonly threadId: ThreadId | null
}

export interface NotifierService {
  /**
   * Tells one Person something happened: stores the notification and wakes their open clients.
   * A Person who turned notifications off in Settings is not told; that is their choice and not an
   * error. Every other domain notifies through here and never writes the table itself.
   */
  readonly notify: (notice: Notice) => Effect.Effect<void, DatabaseInfrastructureError>
}

/** Implemented in `notifications/notifier.ts` by `notifierLayer`. */
export class Notifier extends Context.Service<Notifier, NotifierService>()('vivid/Notifier') {}

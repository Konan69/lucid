import { Effect, Option } from 'effect'
import {
  ConnectionPermission,
  ToolOutcome,
  type ConnectionDataClass,
  ServiceId,
} from '@vivid/contracts'
import { permissionsOf, type ConnectionRecord } from './records.ts'

/** Governing operations and alternate emitters come from the Google specifications used by googleFiles.
 * Drafts also occur as messages, threads, history and attachments; schedules occur as free/busy.
 * Unknown operations cannot prove exclusion, so a restricted account refuses them before dispatch.
 * No reviewed server-side filter exists for these payloads yet.
 */
export const classPolicies = {
  GmailDrafts: {
    service: ServiceId.make('google/gmail'),
    governing: 'gmail.users.drafts.list',
    emitters: [
      'gmail.users.drafts',
      'gmail.users.messages',
      'gmail.users.threads',
      'gmail.users.history',
    ],
  },
  CalendarEventSchedules: {
    service: ServiceId.make('google/calendar'),
    governing: 'calendar.events.list',
    emitters: ['calendar.events', 'calendar.freebusy.query'],
  },
} satisfies Record<
  ConnectionDataClass,
  {
    readonly service: ServiceId
    readonly governing: string
    readonly emitters: readonly string[]
  }
>

/** Explicit Allow lifts a class restriction. Ask remains excluded until that precise class is allowed. */
export const permissionRefusal = Effect.fn('Connections.permissionRefusal')(function* (
  row: ConnectionRecord,
) {
  const decisions = yield* permissionsOf(row.id)
  const excluded = decisions.filter(
    (entry) => classPolicies[entry.dataClass].service === row.service && entry.decision !== 'Allow',
  )
  const first = excluded[0]
  if (first === undefined) return Option.none<ToolOutcome>()
  return Option.some(
    ToolOutcome.cases.PermissionDeclined.make({
      classes: [ConnectionPermission.make(first), ...excluded.slice(1)],
    }),
  )
})

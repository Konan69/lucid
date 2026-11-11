import { observeFailures } from '../observability/failure.ts'
import * as NodeBuffer from 'node:buffer'
import * as NodeCrypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  ActionReceipt,
  ActionTarget,
  type ActionOperation,
  type ActionOperationId,
} from '@vivid/contracts'
import { Clock, Effect, Layer, Option, Schema } from 'effect'
import { ActionLookup, Lookup, resultDigest, retainTarget } from '../actions/journal.ts'
import { Database } from '../database/client.ts'
import { Executor, ExecutorCallOutcome } from './executor.ts'
import { ExecutorMembers, operationsOf } from './members.ts'
import { decodeRow, type ConnectionRecord } from './records.ts'
import { gmailAttachmentSend } from './google.ts'
import { connections } from './tables.ts'

const Fields = Schema.Record(Schema.String, Schema.Json)
const Strings = Schema.Record(Schema.String, Schema.String)
const Mail = Schema.StructWithRest(
  Schema.Struct({
    path: Schema.Struct({ userId: Schema.NonEmptyString }),
    body: Schema.StructWithRest(
      Schema.Struct({
        raw: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+={0,2}$/u)),
      }),
      [Fields],
    ),
  }),
  [Fields],
)
const Calendar = Schema.StructWithRest(
  Schema.Struct({
    path: Schema.Struct({ calendarId: Schema.NonEmptyString }),
    body: Schema.StructWithRest(
      Schema.Struct({
        extendedProperties: Schema.optionalKey(
          Schema.Struct({
            private: Schema.optionalKey(Strings),
            shared: Schema.optionalKey(Strings),
          }),
        ),
      }),
      [Fields],
    ),
  }),
  [Fields],
)
const MailResult = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))),
  nextPageToken: Schema.optionalKey(Schema.NonEmptyString),
})
const CalendarResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
  nextPageToken: Schema.optionalKey(Schema.NonEmptyString),
})
const AttachmentMail = Schema.StructWithRest(
  Schema.Struct({ messageId: Schema.optionalKey(Schema.String) }),
  [Fields],
)
const decodeAttachmentMail = Schema.decodeUnknownOption(AttachmentMail)
const decodeMail = Schema.decodeUnknownOption(Mail)
const decodeCalendar = Schema.decodeUnknownOption(Calendar)
const decodeMailResult = Schema.decodeUnknownEffect(MailResult)
const decodeCalendarResult = Schema.decodeUnknownEffect(CalendarResult)
const Search = Schema.TaggedUnion({
  Mail: { input: Schema.Json },
  Calendar: { input: Schema.Json },
})
type Search = typeof Search.Type
const mailSend = 'gmailApi.gmailUsersMessagesSend'
const eventCreate = 'calendarApi.calendarEventsInsert'

/** A bounded provider-safe correlation, independent of tool input or any model-supplied marker. */
const markerOf = (id: ActionOperationId) => NodeCrypto.createHash('sha256').update(id).digest('hex')

/** Replace only the MIME Message-ID header; latin1 preserves every body and attachment byte. */
const markMail = (raw: string, marker: string) => {
  const mime = NodeBuffer.Buffer.from(raw, 'base64url').toString('latin1')
  const boundary = /\r?\n\r?\n/u.exec(mime)
  if (boundary === null) return Option.none<string>()
  const headers = mime
    .slice(0, boundary.index)
    .replace(/^Message-ID:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n?/gimu, '')
    .replace(/\r?\n$/u, '')
  return Option.some(
    NodeBuffer.Buffer.from(
      `Message-ID: <vivid-${marker}@actions.vivid.invalid>${headers.length === 0 ? '' : `\r\n${headers}`}${mime.slice(boundary.index)}`,
      'latin1',
    ).toString('base64url'),
  )
}

/** Only curated JSON sends support correlation. Unrecognised input retains its normal validation. */
export const prepareReconciliation = Effect.fn('Connections.prepareReconciliation')(function* (
  row: ConnectionRecord,
  target: typeof ActionTarget.cases.Connection.Type,
  operation: ActionOperationId,
) {
  const marker = markerOf(operation)
  let input: Schema.Json = target.input
  if (row.service === 'google/gmail' && target.tool === gmailAttachmentSend) {
    const parsed = decodeAttachmentMail(target.input)
    if (Option.isNone(parsed)) return target
    input = { ...parsed.value, messageId: `vivid-${marker}@actions.vivid.invalid` }
  } else if (row.service === 'google/gmail' && target.tool === mailSend) {
    const parsed = decodeMail(target.input)
    if (Option.isNone(parsed)) return target
    const raw = markMail(parsed.value.body.raw, marker)
    if (Option.isNone(raw)) return target
    input = { ...parsed.value, body: { ...parsed.value.body, raw: raw.value } }
  } else if (row.service === 'google/calendar' && target.tool === eventCreate) {
    const parsed = decodeCalendar(target.input)
    if (Option.isNone(parsed)) return target
    const properties = Option.getOrElse(
      Option.fromUndefinedOr(parsed.value.body.extendedProperties),
      (): NonNullable<typeof parsed.value.body.extendedProperties> => ({}),
    )
    const privateProperties = Option.getOrElse(
      Option.fromUndefinedOr(properties.private),
      () => ({}),
    )
    input = {
      ...parsed.value,
      body: {
        ...parsed.value.body,
        extendedProperties: {
          ...properties,
          private: { ...privateProperties, vividOperation: marker },
        },
      },
    }
  } else return target
  const sending = ActionTarget.cases.Connection.make({ ...target, input })
  yield* retainTarget(operation, sending)
  return sending
})

/** Gmail searches only the server-authored Message-ID retained in the journal's MIME. */
const mailQuery = (operation: ActionOperation): Option.Option<Search> => {
  if (!ActionTarget.guards.Connection(operation.target)) return Option.none()
  const marker = markerOf(operation.id)
  if (operation.target.tool === gmailAttachmentSend) {
    const parsed = decodeAttachmentMail(operation.target.input)
    if (Option.isNone(parsed) || parsed.value.messageId !== `vivid-${marker}@actions.vivid.invalid`)
      return Option.none()
    return Option.some(
      Search.cases.Mail.make({
        input: {
          path: { userId: 'me' },
          query: {
            q: `rfc822msgid:<vivid-${marker}@actions.vivid.invalid>`,
            includeSpamTrash: true,
            maxResults: 1,
          },
        },
      }),
    )
  }
  const parsed = decodeMail(operation.target.input)
  if (Option.isNone(parsed)) return Option.none()
  const mime = NodeBuffer.Buffer.from(parsed.value.body.raw, 'base64url').toString('latin1')
  const headers = mime.split(/\r?\n\r?\n/u, 1)[0]
  if (
    headers === undefined ||
    !headers.split(/\r?\n/u).includes(`Message-ID: <vivid-${marker}@actions.vivid.invalid>`)
  )
    return Option.none()
  return Option.some(
    Search.cases.Mail.make({
      input: {
        path: parsed.value.path,
        query: {
          q: `rfc822msgid:<vivid-${marker}@actions.vivid.invalid>`,
          includeSpamTrash: true,
          maxResults: 1,
        },
      },
    }),
  )
}

/** Calendar searches the exact operation private property, including events since deleted. */
const calendarQuery = (operation: ActionOperation): Option.Option<Search> => {
  if (!ActionTarget.guards.Connection(operation.target)) return Option.none()
  const parsed = decodeCalendar(operation.target.input)
  if (Option.isNone(parsed)) return Option.none()
  const marker = markerOf(operation.id)
  const properties = parsed.value.body.extendedProperties
  if (
    properties === undefined ||
    properties.private === undefined ||
    properties.private['vividOperation'] !== marker
  )
    return Option.none()
  return Option.some(
    Search.cases.Calendar.make({
      input: {
        path: parsed.value.path,
        query: {
          privateExtendedProperty: [`vividOperation=${marker}`],
          showDeleted: true,
          maxResults: 1,
        },
      },
    }),
  )
}

/** Legacy unmarked requests cannot prove absence. Only curated provider/tool pairs opt in. */
const queryFor = (operation: ActionOperation, row: ConnectionRecord): Option.Option<Search> => {
  if (!ActionTarget.guards.Connection(operation.target)) return Option.none()
  if (
    row.service === 'google/gmail' &&
    (operation.target.tool === mailSend || operation.target.tool === gmailAttachmentSend)
  )
    return mailQuery(operation)
  if (row.service === 'google/calendar' && operation.target.tool === eventCreate)
    return calendarQuery(operation)
  return Option.none()
}

/** Provider transport, validation and pagination uncertainty never count as evidence of absence. */
const look = Effect.fn('Connections.lookupAction')(function* (operation: ActionOperation) {
  yield* Effect.annotateCurrentSpan('vivid.operation.id', operation.id)
  if (!ActionTarget.guards.Connection(operation.target)) return Lookup.cases.Unsupported.make({})
  yield* Effect.annotateCurrentSpan('vivid.connection.id', operation.target.connectionId)
  const database = yield* Database
  // The journal's trusted target was authorized at dispatch; only a digest leaves this adapter.
  const [stored] = yield* database.run(
    database.select().from(connections).where(eq(connections.id, operation.target.connectionId)),
  )
  if (stored === undefined) return Lookup.cases.Unsupported.make({})
  const row = yield* decodeRow(stored)
  const query = queryFor(operation, row)
  if (Option.isNone(query)) return Lookup.cases.Unsupported.make({})
  const outcome = yield* (yield* operationsOf(row)).call({
    references: row.references,
    tool: Search.match(query.value, {
      Mail: () => 'gmailApi.gmailUsersMessagesList',
      Calendar: () => 'calendarApi.calendarEventsList',
    }),
    input: query.value.input,
  })
  if (!ExecutorCallOutcome.guards.Completed(outcome)) return Lookup.cases.Unsupported.make({})
  const parsed = Search.guards.Mail(query.value)
    ? yield* decodeMailResult(outcome.value).pipe(
        Effect.map((value) => ({
          items: Option.getOrElse(Option.fromUndefinedOr(value.messages), () => []),
          nextPageToken: value.nextPageToken,
        })),
      )
    : yield* decodeCalendarResult(outcome.value)
  if (parsed.items.length > 0)
    return Lookup.cases.Found.make({
      receipt: ActionReceipt.cases.Completed.make({
        operationId: operation.id,
        completedAt: yield* Clock.currentTimeMillis,
        resultDigest: resultDigest(outcome.value),
      }),
    })
  // The journal applies the landing window to absence, including still-dispatching attempts.
  // Gmail never proves absence: its search index lags a send, and whether Gmail keeps the
  // Message-ID Vivid wrote has not been proven against a real account, so an empty search could
  // turn a sent message into a retry and a second email. Calendar's private property is stored
  // with the event and listed directly, so an empty, complete listing is evidence.
  return Search.guards.Calendar(query.value) && parsed.nextPageToken === undefined
    ? Lookup.cases.Absent.make({})
    : Lookup.cases.Unsupported.make({})
})

/** Capture the production authorities, including the Connection owner's member caller. Lookup never sends. */
export const actionLookupLayer = Layer.effect(
  ActionLookup,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | Executor | ExecutorMembers>()
    return ActionLookup.of({
      look: (operation) =>
        look(operation).pipe(
          Effect.provideContext(services),
          observeFailures('http'),
          Effect.orElseSucceed(() => Lookup.cases.Unsupported.make({})),
        ),
    })
  }),
)

import * as NodeBuffer from 'node:buffer'
import {
  ApprovalContentDigest,
  ApprovalPrecondition,
  GmailMessageId,
  GmailThreadId,
  InvalidRequest,
  type ActionTarget,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { canonical, contentDigest } from '../approvals/action.ts'
import { Executor, ExecutorCallOutcome } from './executor.ts'
import { gmailServiceId } from './google.ts'
import type { ConnectionRecord } from './records.ts'

// Names and inputs follow google-gmail.json and Executor beta.23's openapi-names/request source.
const send = 'gmailApi.gmailUsersMessagesSend'
const sendDraft = 'gmailApi.gmailUsersDraftsSend'
const Message = Schema.Struct({
  raw: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+={0,2}$/u)),
  threadId: Schema.optionalKey(GmailThreadId),
})
const DraftReply = Schema.Struct({ message: Message })
const Path = Schema.Struct({ userId: Schema.NonEmptyString })
const Direct = Schema.Struct({ path: Path, body: Message })
const Draft = Schema.Struct({
  path: Path,
  body: Schema.Struct({ id: Schema.NonEmptyString, message: Schema.optionalKey(Message) }),
})
const Thread = Schema.Struct({
  messages: Schema.NonEmptyArray(Schema.Struct({ id: GmailMessageId, payload: Schema.Json })),
})

/** Bad or unavailable provider state prevents sending; no substitute envelope is invented. */
const unverifiable = () =>
  new InvalidRequest({
    message: 'Gmail sending state could not be verified. Read the draft and thread again.',
  })

/** Each provider payload is decoded once where it enters the mail adapter. */
const decode = <A>(schema: Schema.Decoder<A>, value: Schema.Json) =>
  Schema.decodeEffect(schema)(value).pipe(Effect.mapError(unverifiable))

/** These fixed GET operations use the same server-owned Integration account as the send. */
const read = Effect.fn('Mail.read')(function* (
  row: ConnectionRecord,
  tool: string,
  input: Schema.Json,
) {
  const result = yield* (yield* Executor)
    .call({ references: row.references, tool, input })
    .pipe(Effect.mapError(unverifiable))
  if (!ExecutorCallOutcome.guards.Completed(result)) return yield* unverifiable()
  return result.value
})

/** Raw Gmail MIME contains the actual audience and all attachment bytes, including reply-all.
 * Hashing every decoded byte also binds subject, body and external attachment versions without
 * maintaining a second, potentially divergent MIME parser or trusting model-supplied recipients. */
const mimeDigest = (raw: string) =>
  ApprovalContentDigest.make(
    contentDigest(NodeBuffer.Buffer.from(raw, 'base64url').toString('base64url')),
  )

/** A provider draft is mutable even though the stored send invocation contains only its id. */
const outgoing = Effect.fn('Mail.outgoing')(function* (
  row: ConnectionRecord,
  target: typeof ActionTarget.cases.Connection.Type,
) {
  if (target.tool === send) {
    const input = yield* decode(Direct, target.input)
    return { path: input.path, message: input.body, digest: mimeDigest(input.body.raw) }
  }
  const input = yield* decode(Draft, target.input)
  const value = yield* read(row, 'gmailApi.gmailUsersDraftsGet', {
    path: { ...input.path, id: input.body.id },
    query: { format: 'raw' },
  })
  const draft = yield* decode(DraftReply, value)
  // Gmail permits supplying replacement MIME on send. Bind that exact replacement as well as
  // the live draft, so neither an edited draft nor an inline override can widen the approval.
  const message = Option.getOrElse(Option.fromUndefinedOr(input.body.message), () => draft.message)
  return {
    path: input.path,
    message,
    digest: ApprovalContentDigest.make(
      contentDigest(
        canonical({
          draft: mimeDigest(draft.message.raw),
          outgoing: mimeDigest(message.raw),
        }),
      ),
    ),
  }
})

/** Only the curated Gmail identity opts in. Other Integrations retain their current behavior.
 * Full thread content is refreshed alongside its latest id, so a new reply or changed source
 * cannot inherit permission granted against an older conversation. No polling or send occurs. */
export const inspectMail = Effect.fn('Mail.inspect')(function* (
  row: ConnectionRecord,
  target: typeof ActionTarget.cases.Connection.Type,
) {
  if (row.service !== gmailServiceId) return []
  if (target.tool === `${send}Media` || target.tool === `${sendDraft}Media`)
    return yield* new InvalidRequest({
      message: 'Use Gmail JSON raw MIME sending so the envelope can be approved.',
    })
  if (target.tool !== send && target.tool !== sendDraft) return []
  const prepared = yield* outgoing(row, target)
  const threadId = Option.fromUndefinedOr(prepared.message.threadId)
  if (Option.isNone(threadId))
    return [
      ApprovalPrecondition.cases.MailEnvelope.make({ mimeDigest: prepared.digest, thread: null }),
    ]
  const source = yield* read(row, 'gmailApi.gmailUsersThreadsGet', {
    path: { ...prepared.path, id: threadId.value },
    query: { format: 'full' },
  })
  const thread = yield* decode(Thread, source)
  const latest = thread.messages[thread.messages.length - 1]
  if (latest === undefined) return yield* unverifiable()
  return [
    ApprovalPrecondition.cases.MailEnvelope.make({
      mimeDigest: prepared.digest,
      thread: {
        id: threadId.value,
        latestMessageId: latest.id,
        sourceDigest: ApprovalContentDigest.make(contentDigest(canonical(thread.messages))),
      },
    }),
  ]
})

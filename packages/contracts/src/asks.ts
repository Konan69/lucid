import { Effect, Schema } from 'effect'
import * as McpSchema from 'effect/ai/McpSchema'
import { ActionOperationId } from './identity.js'

/** Preserve the protocol's field kinds, required list, choices and descriptions without flattening them. */
export const IntegrationForm = Schema.Struct({
  mode: Schema.Literal('form'),
  message: Schema.String,
  requestedSchema: Schema.toEncoded(McpSchema.ElicitRequestFormParams.fields.requestedSchema),
})

/** The saved call Executor will resume, including its exact version, arguments and account identities. */
export const IntegrationSavedCall = Schema.Struct({
  app: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  tool: Schema.NonEmptyString,
  kind: Schema.optionalKey(Schema.Literals(['query', 'mutation'])),
  input: Schema.Json,
  accounts: Schema.Struct({
    app: Schema.Record(Schema.String, Schema.Json),
    user: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
})

/** The opaque continuation identity issued by the Integration transport. */
export const IntegrationRequestId = Schema.NonEmptyString.pipe(Schema.brand('IntegrationRequestId'))

/** A live approval and a mid-call form own different continuations. Neither is safe to repeat after expiry. */
export const IntegrationPause = Schema.TaggedUnion({
  Approval: {
    requestId: IntegrationRequestId,
    expiresAt: Schema.Finite,
    form: IntegrationForm,
    savedCall: IntegrationSavedCall,
  },
  Input: {
    requestId: IntegrationRequestId,
    expiresAt: Schema.Finite,
    form: IntegrationForm,
  },
})
export type IntegrationPause = typeof IntegrationPause.Type

/** The journal identity belongs to the original call, across every question and answer. */
export const IntegrationContinuation = Schema.Struct({
  pause: IntegrationPause,
  operation: ActionOperationId,
})
export type IntegrationContinuation = typeof IntegrationContinuation.Type

/** Answers are supplied by the Person, never reconstructed by the model. */
export const IntegrationResponse = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('accept'),
    content: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Array(Schema.String)]),
    ),
  }),
  Schema.Struct({ action: Schema.Literals(['decline', 'cancel']) }),
])
export type IntegrationResponse = typeof IntegrationResponse.Type

/** Public ending of one answer. Expired deliberately says nothing about whether earlier work happened. */
export const IntegrationAnswerOutcome = Schema.TaggedUnion({
  Completed: { value: Schema.Json },
  Accepted: { value: Schema.Json },
  Declined: {},
  Cancelled: {},
  Expired: {},
  Waiting: {},
  Uncertain: {},
})
export type IntegrationAnswerOutcome = typeof IntegrationAnswerOutcome.Type

export const integrationWaitingMessage =
  'The Integration asked the Person and is waiting for their answer. Do not repeat the call.'

export const integrationExpiredMessage =
  "The Integration's question expired. It may or may not have acted. Check what happened before asking for it again. A new call needs a new Approval through Vivid."

/** Absence is real for ordinary actions and questions that are not Integration continuations. */
export const noIntegrationContinuation = Schema.NullOr(IntegrationContinuation).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
  Schema.withConstructorDefault(Effect.succeed(null)),
)

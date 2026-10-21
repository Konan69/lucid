import {
  DisplayProgramRefused,
  DisplaySource,
  RuntimeUnavailable,
  type NotFound,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { HttpClientResponse } from 'effect/http'
import { FeedStore } from '../feed/store.ts'
import { Runtime } from '../runtime/client.ts'
import { requireThread } from '../threads/access.ts'
import type { Database, DatabaseInfrastructureError } from '../database/client.ts'

/** Public history is Flue's durable record, the same read used by Runtime.documentRun. */
const History = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      parts: Schema.Array(Schema.Json),
    }),
  ),
})
const decodeHistory = HttpClientResponse.schemaBodyJson(History)
const isText = Schema.is(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }))
const refusal = { message: DisplayProgramRefused.fields.message.literal }

/** Both sources yield the same proven text; their storage authorities and failures remain explicit. */
type StoredDisplay = Effect.Effect<
  { readonly thread: ThreadId; readonly text: string },
  DisplayProgramRefused | NotFound | RuntimeUnavailable | DatabaseInfrastructureError,
  Database | Runtime | FeedStore
>

/** Neither a message's role nor its text comes from the caller. Only public text parts count. */
const messageText = Effect.fn('Code.messageText')(function* (
  source: typeof DisplaySource.cases.ThreadMessage.Type,
  person: PersonId,
) {
  yield* requireThread(source.thread, person)
  const response = yield* (yield* Runtime).read({
    threadId: source.thread,
    suffix: '',
    search: '?view=history',
    accept: 'application/json',
  })
  if (response.status !== 200)
    return yield* new RuntimeUnavailable({ message: 'Display response could not be read' })
  const history = yield* decodeHistory(response).pipe(
    Effect.mapError(() => new RuntimeUnavailable({ message: 'Display response is invalid' })),
  )
  const message = history.messages.find((candidate) => candidate.id === source.message)
  if (message === undefined || message.role !== 'assistant')
    return yield* new DisplayProgramRefused(refusal)
  return message.parts
    .filter(isText)
    .map((part) => part.text)
    .join('\n\n')
}, Effect.scoped)

/** OpenUI embeds JavaScript as a string; preserve exact bytes, allowing only JSON string escaping. */
function contains(text: string, code: string) {
  return text.includes(code) || text.includes(JSON.stringify(code).slice(1, -1))
}

/** Access and authorship precede admission, so forged programs cannot open a Computer or consume a slot. */
export const displayThread = Effect.fn('Code.displayThread')(function* (
  source: DisplaySource,
  person: PersonId,
  code: string,
) {
  const stored = yield* DisplaySource.match<StoredDisplay>(source, {
    ThreadMessage: (message) =>
      messageText(message, person).pipe(Effect.map((text) => ({ thread: message.thread, text }))),
    FeedPost: ({ post }) =>
      Effect.gen(function* () {
        const [display] = yield* (yield* FeedStore).display(person, post)
        if (display === undefined || display.text === null)
          return yield* new DisplayProgramRefused(refusal)
        return { thread: display.thread, text: display.text }
      }),
  })
  if (!contains(stored.text, code)) return yield* new DisplayProgramRefused(refusal)
  return stored.thread
})

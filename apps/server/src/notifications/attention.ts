import * as NodeCrypto from 'node:crypto'
import { Effect } from 'effect'
import {
  Forbidden,
  InvalidRequest,
  NotificationId,
  type NotifyPersonRequest,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { requireThread } from '../threads/access.ts'
import { actingRun } from '../threads/runs.ts'
import { recordNotice } from './notifier.ts'

/** The Run owns deduplication; repeated tool execution cannot create a second identical notice. */
export const notifyPerson = Effect.fn('Notifications.notifyPerson')(function* (input: {
  readonly personId: PersonId
  readonly threadId: ThreadId
  readonly message: typeof NotifyPersonRequest.Type
}) {
  const thread = yield* requireThread(input.threadId, input.personId)
  const run = yield* actingRun(input.threadId, input.personId).pipe(
    Effect.catchTag('NoActingRun', () =>
      Effect.fail(new Forbidden({ message: 'This notification needs an acting Run.' })),
    ),
  )
  const title = input.message.title.trim()
  const body = input.message.body.replace(/\s+/gu, ' ').trim()
  if (title.length === 0 || body.length === 0)
    return yield* new InvalidRequest({
      message: 'A notification needs a title and a short message.',
    })
  const id = NotificationId.make(
    NodeCrypto.createHash('sha256')
      .update(JSON.stringify([run, title, body]))
      .digest('hex'),
  )
  return yield* recordNotice({
    id,
    notice: {
      personId: input.personId,
      companyId: thread.companyId,
      kind: 'needs-you',
      title,
      body,
      threadId: thread.id,
    },
  })
})

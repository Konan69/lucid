import * as NodeCrypto from 'node:crypto'
import { Effect } from 'effect'
import {
  FeedPost,
  Forbidden,
  InvalidRequest,
  NotificationId,
  type CompanyId,
  type NotifyPersonRequest,
  type PersonId,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { requireThread } from '../threads/access.ts'
import { notifiesFrom } from '../threads/place.ts'
import { actingRun } from '../threads/runs.ts'
import { recordNotice } from './notifier.ts'

/** The Run owns deduplication; repeated tool execution cannot create a second identical notice. */
export const notifyPerson = Effect.fn('Notifications.notifyPerson')(function* (input: {
  readonly personId: PersonId
  readonly threadId: ThreadId
  readonly message: typeof NotifyPersonRequest.Type
}) {
  const thread = yield* requireThread(input.threadId, input.personId)
  // Vivid working in a Background Thread reaches the Person only by posting to the Feed.
  if (!notifiesFrom(thread.place))
    return yield* new Forbidden({
      message: 'In the background, tell the Person with post instead; it puts this in their Feed.',
    })
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

/**
 * Tells the Person Vivid put something on their Feed from work nobody was watching. The Run and
 * the post's own content name the notice, as `notifyPerson` names its own: the same post sent
 * again by a retried tool call reads the notice it already made, while a changed post is new news
 * and a new notice. The title is the post's; a `Said` post's words are the body, and a `Drawn`
 * one has none, because its drawing is the card and no summary of it exists to quote.
 */
export const notifyPosted = Effect.fn('Notifications.notifyPosted')(function* (input: {
  readonly personId: PersonId
  readonly thread: { readonly id: ThreadId; readonly companyId: CompanyId | null }
  readonly run: RunId
  readonly post: FeedPost
}) {
  const id = NotificationId.make(
    NodeCrypto.createHash('sha256')
      .update(JSON.stringify([input.run, 'posted', input.post]))
      .digest('hex'),
  )
  return yield* recordNotice({
    id,
    notice: {
      personId: input.personId,
      companyId: input.thread.companyId,
      kind: 'posted',
      title: input.post.title,
      body: FeedPost.match(input.post, { Drawn: () => '', Said: ({ words }) => words }),
      threadId: input.thread.id,
    },
  })
})

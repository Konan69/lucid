import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createUIMessageStreamResponse } from 'ai'

import { streamRun } from './stream.ts'

/** The newest user message of an AI SDK chat request: its client-made id and its text. */
export type ChatTurn = { readonly messageId: string; readonly text: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Text of one UI message part, when it is a text part. */
const partText = (part: unknown) =>
  isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []

/**
 * Read the turn out of the body an AI SDK `DefaultChatTransport` posts: `{ id, messages, trigger }`.
 *
 * Only the last message matters. The transcript is durable in Pi Durable, so the history the client
 * sends along is ignored rather than trusted. `undefined` means the body is not a user turn.
 */
export function chatTurn(body: unknown): ChatTurn | undefined {
  if (!isRecord(body) || !Array.isArray(body['messages'])) return undefined
  const last: unknown = body['messages'].at(-1)
  if (!isRecord(last) || last['role'] !== 'user' || typeof last['id'] !== 'string') return undefined
  if (!Array.isArray(last['parts'])) return undefined
  const text = last['parts'].flatMap(partText).join('\n')
  return text === '' ? undefined : { messageId: last['id'], text }
}

/**
 * Answer one AI SDK chat request from a Pi Durable conversation, as the SSE response `useChat` reads.
 *
 * The caller chooses the conversation, which is where its own authorization belongs. The client's
 * message id is the request id, so a retried POST of the same message joins the existing submission
 * instead of asking the model twice.
 */
export async function respond(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  const turn = chatTurn(await request.json())
  if (turn === undefined) return new Response('Expected a user message', { status: 400 })
  const stream = await streamRun(
    harness,
    { conversationId, content: turn.text, requestId: turn.messageId },
    context,
  )
  return createUIMessageStreamResponse({ stream })
}

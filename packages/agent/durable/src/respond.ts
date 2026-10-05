import type { Context, JsonValue } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createUIMessageStreamResponse } from 'ai'

import { type Answer, answer, decide, type Decision } from './holds.ts'
import { continueRun, streamRun } from './stream.ts'
import { waiting } from './waiting.ts'

/**
 * What an AI SDK chat request asks for, read from its newest message.
 *
 * - `input`: a user message, with its client-made id and its text.
 * - `resume`: the assistant message the client already shows, sent back after the person settled
 *   its holds. `known` are its tool call ids, `decisions` its approval responses, `outputs` the
 *   results the client supplied for tools with no server `execute`.
 */
export type ChatTurn =
  | { readonly kind: 'input'; readonly messageId: string; readonly text: string }
  | {
      readonly kind: 'resume'
      readonly known: readonly string[]
      readonly decisions: readonly Decision[]
      readonly outputs: readonly Answer[]
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Text of one UI message part, when it is a text part. */
const partText = (part: unknown) =>
  isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
    ? [part['text']]
    : []

/** One tool part of a UI message: a typed tool (`tool-<name>`) or a dynamic one. */
type ToolPart = Record<string, unknown> & { readonly toolCallId: string }

const toolParts = (parts: readonly unknown[]) =>
  parts.filter(
    (part): part is ToolPart =>
      isRecord(part) &&
      typeof part['type'] === 'string' &&
      (part['type'].startsWith('tool-') || part['type'] === 'dynamic-tool') &&
      typeof part['toolCallId'] === 'string',
  )

/** The approval response on a tool part, when the person has decided. The approval id is the call id. */
function decisionOf(part: ToolPart): readonly Decision[] {
  const approval = part['approval']
  if (part['state'] !== 'approval-responded' || !isRecord(approval)) return []
  if (typeof approval['approved'] !== 'boolean') return []
  return typeof approval['reason'] === 'string'
    ? [{ callId: part.toolCallId, approved: approval['approved'], reason: approval['reason'] }]
    : [{ callId: part.toolCallId, approved: approval['approved'] }]
}

/** The output on a tool part, as the JSON it arrived in. */
const outputOf = (part: ToolPart): readonly Answer[] =>
  part['state'] === 'output-available'
    ? [{ callId: part.toolCallId, output: part['output'] as JsonValue }]
    : []

function userTurn(
  message: Record<string, unknown>,
  parts: readonly unknown[],
): ChatTurn | undefined {
  if (typeof message['id'] !== 'string') return undefined
  const text = parts.flatMap(partText).join('\n')
  return text === '' ? undefined : { kind: 'input', messageId: message['id'], text }
}

function resumeTurn(parts: readonly unknown[]): ChatTurn | undefined {
  const tools = toolParts(parts)
  if (tools.length === 0) return undefined
  return {
    kind: 'resume',
    known: tools.map((part) => part.toolCallId),
    decisions: tools.flatMap(decisionOf),
    outputs: tools.flatMap(outputOf),
  }
}

/**
 * Read the turn out of the body an AI SDK `DefaultChatTransport` posts: `{ id, messages, trigger }`.
 *
 * Only the last message matters. The transcript is durable in Pi Durable, so the history the client
 * sends along is ignored rather than trusted. `undefined` means the body is neither a user turn nor
 * an assistant message with tool calls.
 */
export function chatTurn(body: unknown): ChatTurn | undefined {
  if (!isRecord(body) || !Array.isArray(body['messages'])) return undefined
  const last: unknown = body['messages'].at(-1)
  if (!isRecord(last) || !Array.isArray(last['parts'])) return undefined
  if (last['role'] === 'user') return userTurn(last, last['parts'])
  return last['role'] === 'assistant' ? resumeTurn(last['parts']) : undefined
}

/**
 * Settle the holds a resumed message carries. A client output is taken only for a call that waits
 * for an answer right now: every finished tool part of the message also has an output, and those
 * were produced here, not supplied by the client.
 */
async function settleHolds(
  harness: Harness,
  conversationId: ConversationId,
  turn: Extract<ChatTurn, { kind: 'resume' }>,
  context: Context,
) {
  for (const decision of turn.decisions) await decide(harness, conversationId, decision, context)
  const answerable = new Set(
    (await waiting(harness, conversationId, context)).flatMap((each) =>
      each.kind === 'answer' ? [each.callId] : [],
    ),
  )
  for (const output of turn.outputs) {
    if (answerable.has(output.callId)) await answer(harness, conversationId, output, context)
  }
}

/**
 * Answer one AI SDK chat request from a Pi Durable conversation, as the SSE response `useChat` reads.
 *
 * The caller chooses the conversation, which is where its own authorization belongs. The client's
 * message id is the request id, so a retried POST of the same message joins the existing submission
 * instead of asking the model twice.
 *
 * A request whose last message is the assistant's is the AI SDK's way to send approval responses
 * and client tool outputs: they are settled, and the response continues the run from there.
 */
export async function respond(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  const turn = chatTurn(await request.json())
  if (turn === undefined)
    return new Response('Expected a user message or a message with tool calls', { status: 400 })
  if (turn.kind === 'input') {
    const stream = await streamRun(
      harness,
      { conversationId, content: turn.text, requestId: turn.messageId },
      context,
    )
    return createUIMessageStreamResponse({ stream })
  }
  await settleHolds(harness, conversationId, turn, context)
  const stream = await continueRun(harness, conversationId, new Set(turn.known), context)
  if (stream === undefined) return new Response('No run made these tool calls', { status: 409 })
  return createUIMessageStreamResponse({ stream })
}

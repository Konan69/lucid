import type { Context, JsonValue } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'

/** A JavaScript host's wire value remains JSON until the public adapter validates it. */
export function requestBudget(
  harness: Harness,
  input: { readonly conversationId: ConversationId; readonly value: JsonValue },
  context: Context,
): Promise<Response>

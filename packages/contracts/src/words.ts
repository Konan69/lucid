import type { ConversationPart } from './conversation.js'

/** Canonical Vivid conversation blocks shared by conversation consumers. */
export interface Worded {
  readonly parts: ReadonlyArray<ConversationPart>
}

/**
 * Each supplied text part is a paragraph. Settled replies have canonical blocks after runtime
 * reconciliation; streaming parts can still split where text and reasoning alternate. Reasoning
 * is neither a paragraph nor evidence that text blocks join. Conversation screens and outbound
 * replies share this extraction rule.
 */
export const textOf = (message: Worded): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')

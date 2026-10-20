import type { FlueConversationPart } from '@flue/sdk'

/** The canonical content blocks Flue exposes to every conversation consumer. */
export interface Worded {
  readonly parts: ReadonlyArray<FlueConversationPart>
}

/**
 * Each text block is a paragraph. Flue's completion projection reconciles live parts with
 * canonical history, so reasoning is neither a paragraph nor evidence that text blocks join.
 * Notices, channel replies, and conversation screens share this rule.
 */
export const textOf = (message: Worded): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')

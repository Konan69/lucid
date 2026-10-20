/**
 * The parts of one conversation message, as far as its words are concerned. The shape is Flue's
 * `FlueConversationMessage['parts']` (`@flue/sdk` 2.2.2, `dist/index.d.mts`), named structurally
 * so this package reads a message without depending on Flue: a text or reasoning part carries
 * `text`, and every other part (a tool, a file, a data part) only says what it is.
 */
export interface Worded {
  readonly parts: ReadonlyArray<
    { readonly type: 'text' | 'reasoning'; readonly text: string } | { readonly type: string }
  >
}

/**
 * A message's words: its text, a paragraph for each stretch that something other than thinking
 * stands between.
 *
 * A model may think in the middle of a sentence. On 16 October 2026 production's model wrote `**`,
 * thought `.`, and went on with `Why Rivers Meander**`. The stored reply has one text block, the
 * provider's (`@flue/runtime` 2.2.2 `dispatch` projects `message.content` block by block), but the
 * live stream carries only each delta's kind, and Flue's client opens a new part whenever the kind
 * changes (`@flue/sdk` 2.2.2 `appendDelta`: "a `kind` change is a block boundary"). Joining those
 * parts as paragraphs drew a lone `**` above the title until the Thread was opened again. So
 * thinking never separates text: text on either side of it is one stretch, as the stored reply
 * says. A tool call or any other part does end one, and the next text is a new paragraph, which is
 * how the stored reply keeps them too.
 *
 * It lives here because the server reads a reply the same way: a finished notice and a channel
 * reply quote the Run's answer (`apps/server/src/runtime/settlement.ts`), from the same live state.
 */
export const textOf = (message: Worded): string => {
  const stretches: Array<string> = []
  // Whether the next text continues the last stretch: nothing but thinking has come since it.
  let open = false
  for (const part of message.parts) {
    if (part.type === 'reasoning') continue
    if (part.type !== 'text' || !('text' in part)) {
      open = false
      continue
    }
    if (open) stretches[stretches.length - 1] += part.text
    else stretches.push(part.text)
    open = true
  }
  return stretches.join('\n\n')
}

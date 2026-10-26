import { defineTool } from '@flue/runtime'
import { SUGGESTED_REPLIES_MOST, SUGGESTED_REPLY_LONGEST, Tool } from '@vivid/contracts'
import * as v from 'valibot'
import { text } from './inputs.ts'

const reply = text(
  'What the person would say next, in their own words, as they would type it.',
  SUGGESTED_REPLY_LONGEST,
)

/**
 * Suggested replies: the next things the Person would likely say, offered under Vivid's reply as
 * taps (Claude Duet and ChatGPT draw theirs the same way). A tap sends the words as the Person's
 * own next message, exactly as if typed.
 *
 * Nothing is recorded anywhere but the call itself. Flue keeps the tool part, with its input, in
 * the conversation history the clients already read (`offeredReplies` in `@vivid/state`), so no
 * table, RPC or server call is needed, and the tool answers at once. The clients show the
 * suggestions only under the newest reply while Vivid is not working, so they are gone as soon as
 * the Person says anything or Vivid starts again.
 *
 * It is not `ask_person`: that is a question Vivid waits on, kept by the server as an Input
 * request. These are only shortcuts for words the Person could equally type.
 */
export function followTools() {
  return [
    defineTool({
      name: Tool.suggest_replies,
      description:
        'Offer the person one to three short replies they can tap instead of typing, shown under your reply. Use it only when there is an obvious next step they would likely say, such as "Yes, send it" or "Not yet". Write each in their own voice, as they would type it, a few words long. Call it at most once, as the last thing in your reply. Never use it for an open question (use ask_person for questions), and never to repeat what you just said.',
      input: v.object({
        replies: v.pipe(
          v.tupleWithRest([reply], reply),
          v.maxLength(SUGGESTED_REPLIES_MOST),
          v.description('One to three replies, the most likely first.'),
        ),
      }),
      /** The input is the whole effect: Flue stores it in the conversation as this call's part. */
      run() {
        return { output: { ok: true } }
      },
    }),
  ] as const
}

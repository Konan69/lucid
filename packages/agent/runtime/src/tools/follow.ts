import { defineTool } from './tool.ts'
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
 * Nothing is recorded anywhere but the call itself. Pi keeps the tool call, with its input, in
 * the conversation history the clients already read (`ConversationState` tool blocks), so no
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
        'Finish your written answer, then offer one to three replies the person could tap, in their own voice, most likely first. Use {"replies":["send it","make it shorter"]}, each at most 40 characters. Call once in its own tool round, after all other tools. This ends the reply. It is not a question card (ask_person).',
      input: v.strictObject({
        replies: v.pipe(
          v.array(reply),
          v.minLength(1),
          v.maxLength(SUGGESTED_REPLIES_MOST),
          v.description('One to three strings of at most 40 characters, the most likely first.'),
        ),
      }),
      /**
       * The input is the whole effect: Pi stores it in the conversation as this call's part. The
       * call is the last thing in a reply, so it ends the run (Pi's `control.terminate`, kept when
       * every result of the round asks for it): without it the model was asked once more and wrote
       * its reply a second time under the suggestions, as every verify trial on 29 Oct 2026 showed.
       */
      run() {
        return { output: { ok: true }, terminate: true }
      },
    }),
  ] as const
}

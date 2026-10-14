import { BuiltinActionType, Renderer, type ActionEvent } from '@openuidev/react-lang'
import { said } from '@vivid/state'
import { library } from './library'
import './skin.css'

/**
 * A display in Vivid's reply, drawn from its program by OpenUI's renderer with the parts in
 * `library.ts`, from its first line: while the reply is still arriving the renderer draws what it
 * has and fills the rest in. `skin.css` gives the parts Vivid's own colours and shapes.
 *
 * A Button that answers Vivid (`@ToAssistant`) says its words as the Person's next message, with
 * the fields of its form as lines under them. That is only live on the newest reply: an older
 * display is a record of what was asked, and pressing it would answer a question Vivid has stopped
 * asking, so there the buttons are drawn as spent and the press is not taken. What a display
 * changes inside itself (a tile picked, a field typed) needs no reply and always works.
 */
export function Display({
  text,
  arriving,
  live,
  onSay,
}: {
  /** The display, in OpenUI Lang, exactly as Vivid wrote it. */
  text: string
  /** Whether more of it is still to come. */
  arriving: boolean
  /** Whether this is the newest thing Vivid said and it is waiting for the Person. */
  live: boolean
  onSay: (words: string) => void
}) {
  const answer = (event: ActionEvent) => {
    if (!live || event.type !== BuiltinActionType.ContinueConversation) return
    onSay(said(event.humanFriendlyMessage, event.formState === undefined ? {} : event.formState))
  }
  return (
    <section
      data-parts={live ? 'live' : 'spent'}
      className="mt-3 min-w-0 overflow-hidden rounded-card p-4 edge"
    >
      <Renderer response={text} library={library} isStreaming={arriving} onAction={answer} />
    </section>
  )
}

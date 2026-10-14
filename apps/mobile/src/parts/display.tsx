import { BuiltinActionType, Renderer, type ActionEvent } from '@openuidev/react-lang'
import { StyleSheet, View } from 'react-native'
import { said } from '@vivid/state'
import { library } from './library'
import { useSkin } from './style'

/**
 * A display in Vivid's reply, drawn from its program by OpenUI's `Renderer` with the phone's
 * parts, from its first line: while the reply is still arriving the renderer draws what it has
 * and fills the rest in. The skin under it is the display's own tint, as the web's is, so a
 * display reads as one raised thing inside the words.
 *
 * A Button that answers Vivid (`@ToAssistant`) says its words as the Person's next message, with
 * the fields of its form as lines under them. That is only live on the newest reply: an older
 * display is a record of what was asked, and pressing it would answer a question Vivid has
 * stopped asking, so there the buttons are drawn as spent and the press is not taken. What a
 * display changes inside itself (a tile picked, a field typed) needs no reply and always works.
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
  const skin = useSkin()
  const answer = (event: ActionEvent) => {
    if (!live || event.type !== BuiltinActionType.ContinueConversation) return
    const words = said(event.humanFriendlyMessage, event.formState === undefined ? {} : event.formState)
    // An answer with no words is never sent: a press that names nothing would arrive as an empty
    // letter, and saying nothing is not saying something quietly.
    if (words.trim() !== '') onSay(words)
  }
  return (
    // An older display's answers read as spent by their own drawn opacity (`controls.tsx` turns a
    // press away when the display is not live); the tint carries the whole display on both.
    <View
      data-parts={live ? 'live' : 'spent'}
      style={[styles.sheet, { backgroundColor: skin.tint }]}
    >
      <Renderer response={text} library={library} isStreaming={arriving} onAction={answer} />
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: {
    marginTop: 8,
    padding: 12,
    borderRadius: 16,
    minWidth: 0,
    overflow: 'hidden',
  },
})

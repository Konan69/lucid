import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type McpClientLike,
  type ParseResult,
} from '@openuidev/react-lang'
import { StyleSheet, View } from 'react-native'
import { Option } from 'effect'
import { callDisplayTool, displayToolAnswer, feed, said, writtenTools } from '@vivid/state'
import { useRef } from 'react'
import { useLiveData, type LiveData } from '../data/live'
import { Recover } from '../ui/Recover'
import { Label } from '../ui/ui'
import { library } from './library'

/** One parser for every display: it only reads which tools a program writes with. */
const parser = createParser(library.toJSONSchema(), 'Col')

/**
 * The tools a display may call: the Person's own Integrations, named `tool@account` as Vivid
 * found them, run through the server for the Person looking at it. The web's `Display` does the
 * same; a `Query` that would change anything is refused there.
 */
function integrations(run: LiveData['run'], writes: ReadonlySet<string>): McpClientLike {
  return {
    callTool: ({ name, arguments: given }) =>
      run(callDisplayTool(name, Option.fromUndefinedOr(given), writes)).then(displayToolAnswer),
  }
}

/**
 * A display in Vivid's reply, drawn from its program by OpenUI's `Renderer` with the phone's
 * parts, from its first line: while the reply is still arriving the renderer draws what it has
 * and fills the rest in. It looks as OpenUI draws it (`style.ts`, `OPENUI`), with nothing laid
 * under it.
 *
 * A Button that answers Vivid (`@ToAssistant`) says its words as the Person's next message, with
 * the fields of its form as lines under them. That is only live on the newest reply: an older
 * display is a record of what was asked, and pressing it would answer a question Vivid has
 * stopped asking, so there the buttons are drawn as spent and the press is not taken. What a
 * display changes inside itself (a tile picked, a field typed) needs no reply and always works.
 *
 * A display that cannot be drawn breaks only itself: `Recover` reports it and puts one line in its
 * place, and tries again when more of the program arrives. Without it one bad program closed the
 * whole app, and every launch reopened the same Thread and closed it again (21 Oct 2026).
 */
export function Display({
  text,
  arriving,
  live,
  onSay,
  onState,
  initial,
}: {
  /** The display, in OpenUI Lang, exactly as Vivid wrote it. */
  text: string
  /** Whether more of it is still to come. */
  arriving: boolean
  /** Whether this is the newest thing Vivid said and it is waiting for the Person. */
  live: boolean
  onSay: (words: string) => void
  /**
   * Hears what the Person has chosen inside it, for a Feed card whose own buttons say it: the
   * program's declared defaults once it is read, then the defaults with every change over them.
   * The web's `Display` does the same, and says why.
   */
  onState?: (chosen: feed.Chosen) => void
  /** Choices to start from, for a card drawn again after being scrolled away. */
  initial?: feed.Chosen
}) {
  const data = useLiveData()
  // The program's declared defaults, from its latest reading; only read when a change arrives.
  const declared = useRef<feed.Chosen>({})
  const read = (result: ParseResult | null) => {
    declared.current = result === null ? {} : result.stateDeclarations
    if (onState !== undefined) onState({ ...declared.current, ...initial })
  }
  const changed = (state: feed.Chosen) => {
    if (onState !== undefined) onState({ ...declared.current, ...state })
  }
  const answer = (event: ActionEvent) => {
    if (!live || event.type !== BuiltinActionType.ContinueConversation) return
    const words = said(
      event.humanFriendlyMessage,
      event.formState === undefined ? {} : event.formState,
    )
    // An answer with no words is never sent: a press that names nothing would arrive as an empty
    // letter, and saying nothing is not saying something quietly.
    if (words.trim() !== '') onSay(words)
  }
  return (
    // An older display's answers read as spent by their own drawn opacity (`controls.tsx` turns a
    // press away when the display is not live).
    <View data-parts={live ? 'live' : 'spent'} style={styles.sheet}>
      <Recover
        from={text}
        fallback={
          <Label size="label" tone="ink-2">
            This part of the reply could not be shown.
          </Label>
        }
      >
        <Renderer
          response={text}
          library={library}
          isStreaming={arriving}
          onAction={answer}
          onParseResult={read}
          initialState={initial}
          onStateUpdate={changed}
          toolProvider={integrations(data.run, writtenTools(parser.parse(text)))}
        />
      </Recover>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: {
    marginTop: 8,
    minWidth: 0,
    overflow: 'hidden',
  },
})

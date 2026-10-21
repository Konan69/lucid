import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type McpClientLike,
  type ParseResult,
  type OpenUIError,
} from '@openuidev/react-lang'
import type { DisplaySource } from '@vivid/contracts'
import { StyleSheet, View } from 'react-native'
import { Option } from 'effect'
import {
  callDisplayTool,
  displayToolAnswer,
  feed,
  said,
  displayTools,
  type DisplayTools,
} from '@vivid/state'
import { useRef } from 'react'
import { useLiveData, type LiveData } from '../data/live'
import { Recover } from '../ui/Recover'
import { Label } from '../ui/ui'
import { library } from './library'

/** The parser supplies call intent and detects ambiguous automatic/button programs. */
const parser = createParser(library.toJSONSchema(), 'Col')

/**
 * Displays call named Integrations or run_code in their own Thread. The shared adapter lets an
 * automatic program, one that runs when the display draws, call no Integration that writes, no
 * browser and no page read; its run_code is still real JavaScript and can write local files or
 * reach the network. It returns OpenUI's error shape, exactly as on the web.
 */
function integrations(
  run: LiveData['run'],
  tools: DisplayTools,
  source: DisplaySource,
): McpClientLike {
  return {
    callTool: ({ name, arguments: given }) =>
      run(callDisplayTool(name, Option.fromUndefinedOr(given), tools, source)).then(
        displayToolAnswer,
      ),
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
  source,
  text,
  arriving,
  live,
  onSay,
  onState,
  initial,
  onError,
}: {
  /**
   * The stored reply or Feed post this display was drawn from. The server runs a program only when
   * its text is in that content, with the authority of the Thread the content belongs to.
   */
  source: DisplaySource
  /** The display, in OpenUI Lang, exactly as Vivid wrote it. */
  text: string
  /**
   * Whether more of it, or more of the reply it stands in, is still to come. A surface passes true
   * while the stretch is not whole, while Vivid is still making the newest reply and this is it,
   * or while this reply's own parts are still streaming (a reply that stopped being the newest
   * can still be arriving). Until all three are settled OpenUI holds the display (`blocked` in react-lang 1.0.0's `useOpenUIState`): its Queries are
   * not read, its Mutations are not taken and its controls are drawn as streaming. When this turns
   * false its Queries run, once, against the reply the server has stored whole.
   */
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
  /** OpenUI reports Query/Mutation failures here; presentation belongs to the surface owner. */
  onError?: (errors: OpenUIError[]) => void
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
          onError={onError}
          toolProvider={integrations(data.run, displayTools(parser.parse(text)), source)}
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

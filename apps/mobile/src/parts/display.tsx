import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type McpClientLike,
} from '@openuidev/react-lang'
import { StyleSheet, View } from 'react-native'
import { VividRpcClient } from '@vivid/client-runtime'
import { displayToolResult, said, writtenTools } from '@vivid/state'
import { Effect, Result, Schema } from 'effect'
import { useLiveData, type LiveData } from '../data/live'
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
    callTool: async ({ name, arguments: given }) => {
      const answered = await run(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          const input = yield* Schema.decodeUnknownEffect(Schema.Json)(given ?? {})
          return yield* client.UseDisplayTool({
            name,
            input,
            kind: writes.has(name) ? 'Mutation' : 'Query',
          })
        }),
      )
      return Result.match(answered, {
        onSuccess: displayToolResult,
        onFailure: () => ({
          content: [{ type: 'text', text: 'Vivid could not reach this.' }],
          isError: true,
        }),
      })
    },
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
  const data = useLiveData()
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
      <Renderer
        response={text}
        library={library}
        isStreaming={arriving}
        onAction={answer}
        toolProvider={integrations(data.run, writtenTools(parser.parse(text)))}
      />
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

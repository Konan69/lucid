import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type McpClientLike,
} from '@openuidev/react-lang'
import { VividRpcClient } from '@vivid/client-runtime'
import { displayToolResult, said, writtenTools } from '@vivid/state'
import { Effect, Result, Schema } from 'effect'
import { run } from '../data/app'
import { library } from './library'

/** One parser for every display: it only reads which tools a program writes with. */
const parser = createParser(library.toJSONSchema(), 'Col')

/**
 * The tools a display may call: the Person's own Integrations, named `tool@account` as Vivid
 * found them. OpenUI's renderer runs a `Query` when the display is drawn and a `Mutation` when the
 * Person presses the button that runs it; the server runs either for the Person, refusing a
 * `Query` that would change anything.
 */
function integrations(writes: ReadonlySet<string>): McpClientLike {
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
 * A display in Vivid's reply, drawn from its program by OpenUI's renderer with the parts in
 * `library.ts`, from its first line: while the reply is still arriving the renderer draws what it
 * has and fills the rest in. It looks as OpenUI draws it: every colour, font and corner comes from
 * the `--iui-*` variables in `vendor/openui/theme.css`, so a theme is swapped by changing those
 * values, never by restyling a part.
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
    <section className="mt-3 min-w-0">
      <Renderer
        response={text}
        library={library}
        isStreaming={arriving}
        onAction={answer}
        toolProvider={integrations(writtenTools(parser.parse(text)))}
      />
    </section>
  )
}

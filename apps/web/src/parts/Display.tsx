import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type McpClientLike,
  type ParseResult,
  type OpenUIError,
} from '@openuidev/react-lang'
import type { ThreadId } from '@vivid/contracts'
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
import { run } from '../data/app'
import { library } from './library'

/** The parser supplies call intent and detects ambiguous automatic/button programs. */
const parser = createParser(library.toJSONSchema(), 'Col')

/**
 * Displays call named Integrations or run_code in their own Thread. OpenUI runs a Query when
 * drawn and a Mutation after a press; the shared adapter preserves that policy and its errors.
 */
function integrations(tools: DisplayTools, thread: Option.Option<ThreadId>): McpClientLike {
  return {
    callTool: ({ name, arguments: given }) =>
      run(callDisplayTool(name, Option.fromUndefinedOr(given), tools, thread)).then(
        displayToolAnswer,
      ),
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
  thread,
  text,
  arriving,
  live,
  onSay,
  onState,
  onError,
}: {
  /** The Thread this reply or card belongs to; absence never borrows the current route. */
  thread: Option.Option<ThreadId>
  /** The display, in OpenUI Lang, exactly as Vivid wrote it. */
  text: string
  /** Whether more of it is still to come. */
  arriving: boolean
  /** Whether this is the newest thing Vivid said and it is waiting for the Person. */
  live: boolean
  onSay: (words: string) => void
  onState?: (chosen: feed.Chosen) => void
  /** OpenUI reports Query/Mutation failures here; presentation belongs to the surface owner. */
  onError?: (errors: OpenUIError[]) => void
}) {
  // The program's declared defaults, from its latest reading. A ref: they are only read when the
  // renderer reports a change, and nothing is drawn from them.
  const declared = useRef<feed.Chosen>({})
  const read = (result: ParseResult | null) => {
    declared.current = result === null ? {} : result.stateDeclarations
    if (onState !== undefined) onState(declared.current)
  }
  const changed = (state: feed.Chosen) => {
    if (onState !== undefined) onState({ ...declared.current, ...state })
  }
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
        onParseResult={read}
        onStateUpdate={changed}
        onError={onError}
        toolProvider={integrations(displayTools(parser.parse(text)), thread)}
      />
    </section>
  )
}

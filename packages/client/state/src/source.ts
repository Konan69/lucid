import type { ConversationMessage } from '@vivid/contracts'
import { Data, Option } from 'effect'

/**
 * The fields of one conversation message that say where it came from
 * (`ConversationMessage`, `@vivid/contracts`). A message has a `signal` only when it is a
 * delivery the server made, and a `settlement` only on the advisory the runtime writes when a
 * reply fails or is stopped.
 */
export type Sourced = Pick<ConversationMessage, 'role' | 'display' | 'signal' | 'settlement'>

/**
 * Where a message in a Thread's conversation came from, which decides whether it is drawn and as
 * what. One reading for the web, the desktop and the phone.
 *
 * - `Person`: a Person's own words in a private Thread, a plain user turn.
 * - `Vivid`: Vivid's reply.
 * - `Said`: a Person speaking in a shared Thread. The server delivers it as a `message` signal;
 *   `turn` names the Run that says who they are and `from` their name, when the server gave them.
 * - `Wake`: a follow-up falling due, with its name when given.
 * - `Saw`: the Integration event a Watch woke Vivid with, drawn as what Vivid saw: its words are the
 *   event itself, whole. `name` is the Watch's. An event delivered before 29 October 2026 carries
 *   no `event` attribute; its words were the model's framing, so it stays plumbing.
 * - `Failed`: the runtime's word that a reply was not finished.
 * - `Plumbing`: everything else, which is never drawn. A reply the Person stopped, and the
 *   deliveries whose outcome a card already tells (an Approval's decision, an answer) or that
 *   only start Vivid speaking.
 */
export type Source = Data.TaggedEnum<{
  Person: {}
  Vivid: {}
  Said: { readonly turn: Option.Option<string>; readonly from: Option.Option<string> }
  Wake: { readonly reason: 'follow-up'; readonly name: Option.Option<string> }
  Saw: { readonly name: Option.Option<string> }
  Failed: {}
  Plumbing: {}
}>
export const Source = Data.taggedEnum<Source>()

/** The signals that wake Vivid without a Person speaking, by the tag the server delivers. */
const WAKES = new Map<string, 'follow-up'>([['follow-up', 'follow-up']])

/**
 * Where a `system`-role message came from. The runtime projects two things as one
 * (`packages/agent/runtime/src/state/project.ts`): a delivery the server made, which carries the
 * tag it was sent under (`signal`), and its own advisory about a reply that failed or was
 * stopped (`settlement`). Both are `display: 'diagnostic'`, so `display` cannot tell which of
 * them a Thread draws. What can:
 *
 * - An advisory is read from `settlement` before anything else: a failed reply is said, a
 *   stopped one is not.
 * - A delivery is drawn only under a tag this reading knows
 *   (`apps/server/src/threads/message.ts`, `runtimeMessage`).
 * - A `system` message with neither is not drawn.
 */
function signalSource(message: Sourced): Source {
  if (message.settlement !== undefined) {
    return message.settlement.outcome === 'failed' ? Source.Failed() : Source.Plumbing()
  }
  if (message.signal === undefined) return Source.Plumbing()
  const { tagName, attributes } = message.signal
  if (tagName === 'message') {
    return Source.Said({
      turn: Option.fromUndefinedOr(attributes.turn),
      from: Option.fromUndefinedOr(attributes.from),
    })
  }
  if (tagName === 'event' && attributes.event !== undefined)
    return Source.Saw({ name: Option.fromUndefinedOr(attributes.name) })
  const reason = WAKES.get(tagName)
  return reason === undefined
    ? Source.Plumbing()
    : Source.Wake({ reason, name: Option.fromUndefinedOr(attributes.name) })
}

/** Where one message came from. A user turn or a reply marked hidden is plumbing too. */
export function sourceOf(message: Sourced): Source {
  if (message.role === 'system') return signalSource(message)
  if (message.display === 'hidden') return Source.Plumbing()
  return message.role === 'user' ? Source.Person() : Source.Vivid()
}

/** Whether a message belongs in the Thread at all: everything but plumbing does. */
export const inThread = (message: Sourced): boolean => !Source.$is('Plumbing')(sourceOf(message))

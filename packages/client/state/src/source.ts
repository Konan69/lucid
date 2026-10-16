import { Data, Option } from 'effect'

/**
 * The fields of one conversation message that say where it came from. The shape is Flue's
 * `FlueConversationMessage` (`@flue/sdk` 2.2.2, `dist/index.d.mts`), named structurally so this
 * package reads a message without depending on Flue. The absences are Flue's own: a message has
 * a `signal` only when its record carried a tag or attributes, and a `settlement` only on the
 * advisory the runtime appends when a submission ends without a reply.
 */
export interface Sourced {
  readonly role: 'user' | 'assistant' | 'system'
  readonly display: 'visible' | 'hidden' | 'diagnostic'
  readonly signal?: {
    readonly tagName?: string
    readonly attributes?: Readonly<Record<string, string>>
  }
  readonly settlement?: { readonly outcome: 'failed' | 'aborted' }
}

/**
 * Where a message in a Thread's conversation came from, which decides whether it is drawn and as
 * what. One reading for the web, the desktop and the phone.
 *
 * - `Person`: a Person's own words in a private Thread, a plain user turn.
 * - `Vivid`: Vivid's reply.
 * - `Said`: a Person speaking in a shared Thread. The server delivers it as a `message` signal;
 *   `turn` names the Run that says who they are and `from` their name, when the server gave them.
 * - `Wake`: a follow-up falling due, with its name when given.
 * - `Failed`: the runtime's word that a reply was not finished.
 * - `Plumbing`: everything else, which is never drawn. The runtime talking to itself or to the
 *   model (instructions reloaded, tools and skills changed, the environment restated, a stream
 *   resumed), a stopped submission, and the signals whose outcome a card already tells (an
 *   Approval's decision, an answer) or that only start Vivid speaking.
 */
export type Source = Data.TaggedEnum<{
  Person: {}
  Vivid: {}
  Said: { readonly turn: Option.Option<string>; readonly from: Option.Option<string> }
  Wake: { readonly reason: 'follow-up'; readonly name: Option.Option<string> }
  Failed: {}
  Plumbing: {}
}>
export const Source = Data.taggedEnum<Source>()

/** The signals that wake Vivid without a Person speaking, by the tag the server delivers. */
const WAKES = new Map<string, 'follow-up'>([['follow-up', 'follow-up']])

/**
 * Where a `system`-role message came from. Flue projects every signal record as one
 * (`conversation-projections.ts`, `classifySignal`, in `@flue/runtime` 2.2.2), all of them
 * `display: 'diagnostic'` but a resumed stream's, so `display` cannot tell the runtime's own
 * signals from the server's. What can:
 *
 * - `instructions` and `environment` carry neither tag nor attributes, so they have no `signal`.
 * - `resources` carries only `attributes.resource`, so it has a `signal` with no tag.
 * - `submission_interrupted` carries attributes too (the submission, its kind and reason), so
 *   the failure is read from `settlement` before the signal is looked at. Reading the signal
 *   first took it for an unknown signal and the notice was never drawn.
 * - The server's own deliveries always carry the tag they were sent under
 *   (`apps/server/src/threads/message.ts`, `flueMessage`), and only a known tag is drawn.
 */
function signalSource(message: Sourced): Source {
  if (message.settlement !== undefined) {
    return message.settlement.outcome === 'failed' ? Source.Failed() : Source.Plumbing()
  }
  if (message.signal === undefined || message.signal.tagName === undefined) return Source.Plumbing()
  const { tagName } = message.signal
  const attributes = message.signal.attributes === undefined ? {} : message.signal.attributes
  if (tagName === 'message') {
    return Source.Said({
      turn: Option.fromUndefinedOr(attributes.turn),
      from: Option.fromUndefinedOr(attributes.from),
    })
  }
  const reason = WAKES.get(tagName)
  return reason === undefined
    ? Source.Plumbing()
    : Source.Wake({ reason, name: Option.fromUndefinedOr(attributes.name) })
}

/** Where one message came from. A user turn or a reply Flue marks hidden is plumbing too. */
export function sourceOf(message: Sourced): Source {
  if (message.role === 'system') return signalSource(message)
  if (message.display === 'hidden') return Source.Plumbing()
  return message.role === 'user' ? Source.Person() : Source.Vivid()
}

/** Whether a message belongs in the Thread at all: everything but plumbing does. */
export const inThread = (message: Sourced): boolean => !Source.$is('Plumbing')(sourceOf(message))

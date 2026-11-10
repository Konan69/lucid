import {
  Workspace,
  type ConversationMessage,
  type PersonSummary,
  type Run,
  type Thread,
  type ThreadId,
} from '@vivid/contracts'
import { Option } from 'effect'

type RuntimeConversation = Omit<Thread, 'id'> & { id: string }

/** Converts Message markdown into the compact preview used by Thread lists. */
function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A web address written out in a message: its scheme, host and anything after the host. */
const ADDRESS = /\bhttps?:\/\/(?:www\.)?([^\s/?#]+)[^\s]*/gi

/**
 * Chooses the first Message line as a bounded Thread title. It is the seed the list shows until
 * the server's title model names the Thread (`apps/server/src/threads/generation.ts`). A web
 * address in it is shortened to its host: a pasted link seeded the title
 * "https://x.com/idrisayobell…" for the minutes until the Thread was named (26 October 2026).
 */
export function titleFromMessage(message: string) {
  const firstLine = (message.trim().split('\n', 1)[0] ?? 'New conversation').replace(
    ADDRESS,
    (_address, host: string) => host,
  )
  return firstLine.length > 46 ? `${firstLine.slice(0, 45).trimEnd()}…` : firstLine
}

/**
 * The Run a message of the conversation belongs to: the one that placed a delivery, or wrote the
 * reply.
 *
 * A message names its delivery by the runtime's own number for it
 * (`ConversationMessage.submissionId`), and a Run carries that number beside its own id
 * (`Run.submissionId`). The two ids are different things: a Run's id is the product's, made
 * before the runtime has seen the delivery, and is never what a message carries. A message
 * without a number, or a Run the runtime has not numbered yet, pairs with nothing.
 */
export const runOf = (
  runs: ReadonlyArray<Run>,
  message: Pick<ConversationMessage, 'submissionId'>,
): Option.Option<Run> =>
  Option.flatMap(Option.fromUndefinedOr(message.submissionId), (submission) =>
    Option.fromUndefinedOr(runs.find((run) => run.submissionId === submission)),
  )

/** A stored picture as the conversation names it: relative to its Thread. */
const STORED = /^attachments\/(.+)$/u

/**
 * Where a picture in a Thread's message is read from, as a path on the app's own server.
 *
 * The conversation names a stored picture relative to its Thread (`attachments/<id>`,
 * `ConversationPart` in `@vivid/contracts`), and the server serves it at
 * `/api/vivid/<thread>/attachments/<id>` to whoever may read the Thread
 * (`apps/server/src/threads/gateway.ts`). It is asked for with the app's own credentials: a
 * browser's session cookie, a phone's token. Any other address is left as it is, which is a
 * picture this client is sending, drawn from the bytes it holds (`data:`).
 */
export const pictureAddress = (thread: ThreadId, url: string): string => {
  const stored = STORED.exec(url)
  if (stored === null) return url
  const [, id] = stored
  return id === undefined
    ? url
    : `/api/vivid/${encodeURIComponent(thread)}/attachments/${encodeURIComponent(id)}`
}

/**
 * Who a turn in the conversation was from: the Person behind the Run that has that turn.
 *
 * The conversation itself never holds an identifier (the model reads everything in it), so a
 * message there says only its turn number and the speaker's name. The Thread's Runs say who that
 * was. `turn` is the attribute as written; anything that is not a delivery has none.
 */
export const speakerOfTurn = (
  runs: ReadonlyArray<Run>,
  turn: Option.Option<string>,
): Option.Option<PersonSummary> =>
  Option.flatMap(turn, (written) =>
    Option.map(
      Option.fromUndefinedOr(runs.find((run) => String(run.turn) === written)),
      (run) => run.origin.person,
    ),
  )

/**
 * Which workspace a Person is in, as one comparable word: their own space, or one Company. Client
 * state that belongs to a workspace (a screen's open item, a half-written new Thread) is keyed by
 * it, so nothing of one Company is left standing under another.
 */
export const workspaceKey = (workspace: Workspace): string =>
  Workspace.match(workspace, {
    Personal: () => 'personal',
    Company: ({ company }) => company.id,
  })

/**
 * How Vivid is doing in a Thread, in the words every surface puts under the Thread's title. Vivid
 * is in the Thread, not just named by it: when nothing is happening it is "here", not idle. A new
 * kind of attention fails to compile here until it has words.
 */
export const standingWords = {
  Working: 'Working on it…',
  NeedsYou: 'Waiting for you',
  Unread: 'Here with you',
  Quiet: 'Here with you',
} as const satisfies Record<Thread['attention'], string>

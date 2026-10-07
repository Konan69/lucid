import {
  InvalidArgumentError,
  type ChatOnFinishCallback,
  type PrepareReconnectToStreamRequest,
  type UIMessage,
} from 'ai'

/** The two SDK ingress callbacks share one retained-message record without a platform dependency. */
export type Resumption = {
  readonly prepare: PrepareReconnectToStreamRequest
  readonly onFinish: ChatOnFinishCallback<UIMessage>
}

type State = { record?: Rejoin }

type Rejoin = { readonly messageId: string; readonly steps: number }

/** Match http-chat-transport.ts:14–20,251–269, including relative URLs and existing query/fragments. */
function reconnectUrl(api: string, id: string, record: Rejoin): string {
  if (id === '.' || id === '..')
    throw new InvalidArgumentError({
      parameter: 'chatId',
      value: id,
      message: 'Chat IDs must not be "." or ".." when using the default reconnect URL.',
    })
  const split = api.search(/[?#]/u)
  const path = `/${encodeURIComponent(id)}/stream`
  const url = split === -1 ? `${api}${path}` : `${api.slice(0, split)}${path}${api.slice(split)}`
  const fragment = url.indexOf('#')
  const head = fragment === -1 ? url : url.slice(0, fragment)
  const tail = fragment === -1 ? '' : url.slice(fragment)
  const query = head.indexOf('?')
  const params = new URLSearchParams(query === -1 ? '' : head.slice(query + 1))
  params.set('message', record.messageId)
  params.set('steps', String(record.steps))
  return `${query === -1 ? head : head.slice(0, query)}?${params}${tail}`
}

/**
 * Wire prepare to DefaultChatTransport and onFinish to Chat/useChat. SDK chat.ts:1008–1018 keeps
 * resumableStreamState only on disconnect, and :872–874 reuses it on resumeStream. Count the same
 * retained step-start parts so the server replaces only the current step, preserving earlier ones.
 * An empty override is required by PrepareReconnectToStreamRequest's return type and leaves the
 * stock reconnect URL untouched. This transport helper has no platform or Effect dependency.
 */
export function resumption(): Resumption {
  const state: State = {}
  const onFinish: ChatOnFinishCallback<UIMessage> = ({ message, isDisconnect }) => {
    if (isDisconnect)
      state.record = {
        messageId: message.id,
        steps: message.parts.filter((part) => part.type === 'step-start').length,
      }
    else delete state.record
  }
  const prepare: PrepareReconnectToStreamRequest = ({ api, id }) => {
    const record = state.record
    if (record === undefined || record.steps < 1) return {}
    return { api: reconnectUrl(api, id, record) }
  }
  return { prepare, onFinish }
}

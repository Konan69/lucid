import { isToolUIPart, type ChatTransport, type UIMessage, type UIMessageChunk } from 'ai'

/** Type-only wire contract: loading client transport imports no Pi or Effect runtime. */
export type { Metadata } from './message.ts'

/** Reserved protocol marker: this local interruption is never a person-supplied tool result. */
export const connectionLostInput =
  '@vivid/durable: the connection was lost before this tool input arrived'

/** A plain Error deliberately avoids chat.ts:1008–1018's TypeError network-state retention. */
export class ConnectionLost extends Error {
  constructor(cause: ErrorOptions['cause']) {
    super('The connection was lost; resume the stream to reconnect.', { cause })
    this.name = 'ConnectionLost'
  }
}

type Signal = Parameters<ChatTransport<UIMessage>['sendMessages']>[0]['abortSignal']
type Started = Extract<UIMessageChunk, { type: 'tool-input-start' }>
type Interrupted = Extract<UIMessageChunk, { type: 'tool-input-error' }>

/** Abort signals preserve cancellation even when its exception comes from another realm.
 * Without a signal, standard Error and DOMException names identify transport-thrown AbortError exceptions. */
function aborted(cause: ErrorOptions['cause'], signal: Signal): boolean {
  if (signal !== undefined && signal.aborted) return true
  const exception =
    cause instanceof Error || ('DOMException' in globalThis && cause instanceof DOMException)
  return exception && cause.name === 'AbortError'
}

/** Preserve cancellation; callers choose this conversion only for network acquisition or read failures. */
function lost(cause: ErrorOptions['cause'], signal: Signal): never {
  if (aborted(cause, signal)) throw cause
  throw new ConnectionLost(cause)
}

/** At acquisition an HTTP refusal is the SDK's plain Error, not a dropped connection.
 * Fetch rejects with TypeError; TimeoutError names timeout exceptions across realms. Only those
 * are resumable before a stream exists (chat.ts:1008–1018); typed status text passes through. */
function acquisitionLost(cause: ErrorOptions['cause'], signal: Signal): never {
  if (aborted(cause, signal)) throw cause
  const exception =
    cause instanceof Error || ('DOMException' in globalThis && cause instanceof DOMException)
  if (cause instanceof TypeError || (exception && cause.name === 'TimeoutError'))
    return lost(cause, signal)
  throw cause
}

/** Preserve the started call's identity and SDK flags without inventing a parsed partial input. */
function interrupted(start: Started): Interrupted {
  const { type: _type, ...identity } = start
  return { ...identity, type: 'tool-input-error', input: undefined, errorText: connectionLostInput }
}

const terminalInputs = new Set<string>([
  'tool-input-available',
  'tool-input-error',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
])

/** SDK process-ui-message-stream.ts:742–779 closes input-error in place, clearing partial input,
 * raw input, output and preliminary state, while preserving identity, title and provider metadata.
 * stop() does not notify a transport ledger, and saved client messages may hold the same partials.
 * Close them before resume so chat.ts:852–858 cannot seed its next reader from an unfinished input.
 * This pure copy does not mutate the host's saved list and imports no runtime beyond plain ai helpers. */
export function closeInputs<M extends UIMessage>(messages: readonly M[]): M[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== 'input-streaming') return part
      return {
        ...part,
        state: 'output-error',
        input: undefined,
        output: undefined,
        rawInput: undefined,
        preliminary: undefined,
        errorText: connectionLostInput,
      }
    }),
  }))
}

/** A source error bypasses transforms. Read explicitly and deliver each synthetic terminal input
 * before failing the next read. Zero prefetch prevents controller.error from discarding those
 * queued chunks. Every observation owns its own ledger; shared transports hold no client state. */
function guarded(
  source: ReadableStream<UIMessageChunk>,
  signal: Signal,
): ReadableStream<UIMessageChunk> {
  const reader = source.getReader()
  const open = new Map<string, Started>()
  const pending: Interrupted[] = []
  let reading:
    | { readonly status: 'Reading' }
    | { readonly status: 'Failed'; readonly error: ConnectionLost } = { status: 'Reading' }
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  const emitFailure = (
    controller: ReadableStreamDefaultController<UIMessageChunk>,
    error: ConnectionLost,
  ) => {
    const chunk = pending.shift()
    if (chunk !== undefined) controller.enqueue(chunk)
    else controller.error(error)
  }
  return new ReadableStream<UIMessageChunk>(
    {
      pull: function readForSdk(controller) {
        if (reading.status === 'Failed') return emitFailure(controller, reading.error)
        return reader.read().then(
          ({ done, value }) => {
            if (done) {
              release()
              controller.close()
              return
            }
            if (value.type === 'tool-input-start') open.set(value.toolCallId, value)
            if ('toolCallId' in value && terminalInputs.has(value.type))
              open.delete(value.toolCallId)
            if (value.type === 'reset-step') open.clear()
            controller.enqueue(value)
          },
          function failedForSdk(cause) {
            release()
            if (aborted(cause, signal)) return controller.error(cause)
            const error = new ConnectionLost(cause)
            reading = { status: 'Failed', error }
            pending.push(...Array.from(open.values(), interrupted))
            open.clear()
            emitFailure(controller, error)
          },
        )
      },
      cancel: function cancelForSdk(reason) {
        return released ? Promise.resolve() : reader.cancel(reason).finally(release)
      },
    },
    { highWaterMark: 0 },
  )
}

/** Wrap any SDK transport's chunk streams, including non-HTTP and React Native transports.
 * chat.ts:852–858 seeds a message containing input-streaming tools; closing those parts and using
 * a plain ConnectionLost prevents both that seed and :1008–1018's retained private stream state.
 * Whole-run replay then replaces the partial message by id. Abort and null idle results pass through.
 * After a long gap load history first: reconnect supplies only the run currently in progress. */
export function resumable<M extends UIMessage>(transport: ChatTransport<M>): ChatTransport<M> {
  return {
    sendMessages: function sendForSdk(input) {
      return Promise.resolve()
        .then(() => transport.sendMessages(input))
        .then((stream) => guarded(stream, input.abortSignal))
        .catch((cause) => acquisitionLost(cause, input.abortSignal))
    },
    reconnectToStream: function reconnectForSdk(input) {
      return Promise.resolve()
        .then(() => transport.reconnectToStream(input))
        .then((stream) => (stream === null ? null : guarded(stream, input.abortSignal)))
        .catch((cause) => acquisitionLost(cause, input.abortSignal))
    },
  }
}

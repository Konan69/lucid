import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

/** Reserved protocol marker: this local interruption is never a person-supplied tool result. */
export const connectionLostInput =
  '@vivid/durable: the connection was lost before this tool input arrived'

/** A plain Error deliberately avoids chat.ts:1008–1018's TypeError network-state retention. */
export class ConnectionLost extends Error {
  constructor(options: ErrorOptions) {
    super('The connection was lost; resume the stream to reconnect.', options)
    this.name = 'ConnectionLost'
  }
}

type Signal = Parameters<ChatTransport<UIMessage>['sendMessages']>[0]['abortSignal']
type Started = Extract<UIMessageChunk, { type: 'tool-input-start' }>
type Interrupted = Extract<UIMessageChunk, { type: 'tool-input-error' }>

/** Abort signals preserve cancellation even when its exception comes from another realm.
 * Without a signal, standard Error and DOMException names identify transport-thrown AbortError exceptions. */
function aborted(options: ErrorOptions, signal: Signal): boolean {
  if (signal !== undefined && signal.aborted) return true
  const cause = options.cause
  const exception =
    cause instanceof Error || ('DOMException' in globalThis && cause instanceof DOMException)
  return exception && cause.name === 'AbortError'
}

/** Preserve the original cancellation object; every other acquisition failure becomes recoverable. */
function lost(options: ErrorOptions, signal: Signal): never {
  if (aborted(options, signal)) throw options.cause
  throw new ConnectionLost(options)
}

/** Preserve the started call's identity and SDK flags without inventing a parsed partial input. */
function interrupted(start: Started): Interrupted {
  const { type: _type, ...identity } = start
  return { ...identity, type: 'tool-input-error', input: undefined, errorText: connectionLostInput }
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
            if (value.type === 'tool-input-available' || value.type === 'tool-input-error')
              open.delete(value.toolCallId)
            if (value.type === 'reset-step') open.clear()
            controller.enqueue(value)
          },
          function failedForSdk(cause) {
            release()
            if (aborted({ cause }, signal)) return controller.error(cause)
            const error = new ConnectionLost({ cause })
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
        .catch((cause) => lost({ cause }, input.abortSignal))
    },
    reconnectToStream: function reconnectForSdk(input) {
      return Promise.resolve()
        .then(() => transport.reconnectToStream(input))
        .then((stream) => (stream === null ? null : guarded(stream, input.abortSignal)))
        .catch((cause) => lost({ cause }, input.abortSignal))
    },
  }
}

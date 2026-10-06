import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall,
} from '@earendil-works/pi-ai'
import {
  fauxProvider,
  type RegisterFauxProviderOptions,
} from '@earendil-works/pi-ai/providers/faux'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { parseStreamingJson } from '@earendil-works/pi-ai/utils/json-parse'
import { Effect, Match, Schema, Stream } from 'effect'
import { runForPi } from '../pi.ts'

export type ProviderFamily = 'anthropic' | 'openai' | 'bedrock' | 'mistral'
export type ProviderOptions = RegisterFauxProviderOptions & {
  readonly partialFamily?: ProviderFamily
}
const decodeArguments = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))
type PartialState = { readonly family: ProviderFamily; readonly arguments: Map<number, string> }

/**
 * Port the installed provider families: anthropic-messages.js:517/555 and bedrock-converse-stream.js:436/463
 * retain partialJson/index; openai-completions.js:313/440 retains partialArgs/streamIndex; Mistral's
 * mistral-conversations.js:547/556 retains partialArgs. Google generative-ai.js:108 adds textSignature
 * to an already-streaming text block. These are owned copies, never patches to SDK objects.
 */
function partial(message: AssistantMessage, state: PartialState): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block, index) => {
      if (block.type === 'text')
        return block.text.length < 32
          ? block
          : { ...block, textSignature: 'retained-google-signature' }
      if (block.type !== 'toolCall') return block
      return toolPartial(block, index, state)
    }),
  }
}

/** Family-specific scratch fields follow the installed provider rather than faux's empty arguments. */
function toolPartial(block: ToolCall, index: number, state: PartialState): ToolCall {
  const text = state.arguments.get(index)
  if (text === undefined) return block
  const arguments_ = decodeArguments(parseStreamingJson(text))
  return Match.value(state.family).pipe(
    Match.whenOr('anthropic', 'bedrock', () => ({
      ...block,
      arguments: arguments_,
      partialJson: text,
      index,
    })),
    Match.when('openai', () => ({
      ...block,
      arguments: arguments_,
      partialArgs: text,
      streamIndex: index,
    })),
    Match.when('mistral', () => ({ ...block, arguments: arguments_, partialArgs: text })),
    Match.exhaustive,
  )
}

/** Provider terminal blocks strip scratch fields; every delta has its own captured partial copy. */
function adapt(event: AssistantMessageEvent, state: PartialState): AssistantMessageEvent {
  if (event.type === 'done' || event.type === 'error') return event
  if (event.type === 'toolcall_start') state.arguments.set(event.contentIndex, '')
  if (event.type === 'toolcall_delta') {
    const text = state.arguments.get(event.contentIndex)
    if (text === undefined) throw new Error('Faux argument delta before toolcall_start')
    state.arguments.set(event.contentIndex, text + event.delta)
  }
  if (event.type === 'toolcall_end') state.arguments.delete(event.contentIndex)
  return { ...event, partial: partial(event.partial, state) }
}

/** The SDK's async iterator/result are the unsafe provider boundary; all fixture state lives here. */
const relay = Effect.fn('Test.providerRelay')(function* (
  source: AssistantMessageEventStream,
  destination: AssistantMessageEventStream,
  family: ProviderFamily,
) {
  const state: PartialState = { family, arguments: new Map() }
  yield* Stream.fromAsyncIterable(source, String).pipe(
    Stream.runForEach((event) => Effect.sync(() => destination.push(adapt(event, state)))),
  )
  destination.end(yield* Effect.promise(() => source.result()))
})

/** Compose a public provider around faux, leaving its scripting, models and deferred APIs intact. */
export function streamingProvider(options: ProviderOptions = {}) {
  const { partialFamily = 'anthropic', ...fauxOptions } = options
  const faux = fauxProvider(fauxOptions)
  /** Pi's provider API is synchronous: return its event stream and run the owned relay at ingress. */
  const wrap = (source: AssistantMessageEventStream) => {
    const destination = createAssistantMessageEventStream()
    void runForPi(relay(source, destination, partialFamily), undefined)
    return destination
  }
  return {
    ...faux,
    provider: {
      ...faux.provider,
      stream: (...args: Parameters<typeof faux.provider.stream>) =>
        wrap(faux.provider.stream(...args)),
      streamSimple: (...args: Parameters<typeof faux.provider.streamSimple>) =>
        wrap(faux.provider.streamSimple(...args)),
    },
  }
}

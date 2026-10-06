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
import { Effect, Match, Predicate, Schema, Stream } from 'effect'
import { runForPi } from '../pi.ts'

export const providerFamilies = [
  'anthropic',
  'openai',
  'bedrock',
  'mistral',
  'late',
  'responses',
] as const
export type ProviderFamily = (typeof providerFamilies)[number] | 'custom' | 'end' | 'never'
export type ProviderOptions = RegisterFauxProviderOptions & {
  readonly partialFamily?: ProviderFamily
}
const decodeArguments = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))
type PartialState = {
  readonly family: ProviderFamily
  readonly arguments: Map<number, string>
  readonly ended: Set<number>
}

/**
 * Port the installed provider families: anthropic-messages.js:517/555 and bedrock-converse-stream.js:436/463
 * retain partialJson/index; openai-completions.js:313/440 retains partialArgs/streamIndex; Mistral's
 * mistral-conversations.js:547/556 retains partialArgs. Google generative-ai.js:108 adds textSignature
 * to an already-streaming text block. These are owned copies, never patches to SDK objects.
 * OpenAI completions:309/429 and Bedrock:432 can start without identity; late keeps those fields
 * empty until argument deltas reveal them. Responses shared:559/598 replaces whole text/thinking
 * at output_item.done; retain one unsent suffix character until that replacement. Completions:306
 * customInput retains the grammar input property and its JSON buffer instead of partialArgs.
 */
function partial(message: AssistantMessage, state: PartialState): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block, index) => {
      if (state.family === 'responses' && !state.ended.has(index)) {
        if (block.type === 'text') return { ...block, text: block.text.slice(0, -1) }
        if (block.type === 'thinking') return { ...block, thinking: block.thinking.slice(0, -1) }
      }
      if (state.family === 'responses' && state.ended.has(index)) {
        if (block.type === 'text') return { ...block, textSignature: 'responses-whole-text' }
        if (block.type === 'thinking')
          return { ...block, thinkingSignature: 'responses-whole-thinking' }
      }
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
  // Some providers reveal identity only in the terminal result; never uses the scripted empty
  // fields unchanged, matching Bedrock's absent id/name with no subsequent filling branch.
  if (state.family === 'end') return { ...block, id: '', name: '' }
  const text = state.arguments.get(index)
  if (text === undefined) return block
  const arguments_ = decodeArguments(parseStreamingJson(text))
  const identity =
    state.family === 'late'
      ? { id: text.length < 2 ? '' : block.id, name: text.length < 6 ? '' : block.name }
      : { id: block.id, name: block.name }
  return Match.value(state.family).pipe(
    Match.whenOr('anthropic', 'bedrock', 'responses', 'never', () => ({
      ...block,
      arguments: arguments_,
      partialJson: text,
      index,
    })),
    Match.whenOr('openai', 'late', () => ({
      ...block,
      ...identity,
      arguments: arguments_,
      partialArgs: text,
      streamIndex: index,
    })),
    Match.when('mistral', () => ({ ...block, arguments: arguments_, partialArgs: text })),
    Match.when('custom', () => ({
      ...block,
      arguments: arguments_,
      customInput: {
        property: 'input',
        jsonBuffer: {
          input: Predicate.isString(arguments_.input) ? arguments_.input : '',
          started: text.length > 0,
          closed: false,
        },
      },
      streamIndex: index,
    })),
    Match.exhaustive,
  )
}

/** Provider terminal blocks strip scratch fields; every delta has its own captured partial copy. */
function adapt(event: AssistantMessageEvent, state: PartialState): AssistantMessageEvent {
  if (event.type === 'done') return event
  if (event.type === 'error') return { ...event, error: terminal(event.error, state) }
  if (event.type === 'toolcall_start') state.arguments.set(event.contentIndex, '')
  if (event.type === 'toolcall_delta') {
    const text = state.arguments.get(event.contentIndex)
    if (text === undefined) throw new Error('Faux argument delta before toolcall_start')
    state.arguments.set(event.contentIndex, text + event.delta)
  }
  if (event.type === 'toolcall_end') state.arguments.delete(event.contentIndex)
  if (event.type === 'text_end' || event.type === 'thinking_end')
    state.ended.add(event.contentIndex)
  return { ...event, partial: partial(event.partial, state) }
}

/** Anthropic's abort catch strips scratch fields but retains the last parsed partial arguments. */
function terminal(message: AssistantMessage, state: PartialState): AssistantMessage {
  if (message.stopReason !== 'aborted') return message
  const captured = partial(message, state)
  return {
    ...captured,
    content: captured.content.map((block) =>
      block.type === 'toolCall'
        ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
        : block,
    ),
  }
}

/** The SDK's async iterator/result are the unsafe provider boundary; all fixture state lives here. */
const relay = Effect.fn('Test.providerRelay')(function* (
  source: AssistantMessageEventStream,
  destination: AssistantMessageEventStream,
  family: ProviderFamily,
) {
  const state: PartialState = { family, arguments: new Map(), ended: new Set() }
  yield* Stream.fromAsyncIterable(source, String).pipe(
    Stream.runForEach((event) => Effect.sync(() => destination.push(adapt(event, state)))),
  )
  destination.end(terminal(yield* Effect.promise(() => source.result()), state))
})

/** Compose a public provider around faux, leaving its scripting, models and deferred APIs intact. */
export function streamingProvider(options: ProviderOptions = {}) {
  const { partialFamily = 'late', ...fauxOptions } = options
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

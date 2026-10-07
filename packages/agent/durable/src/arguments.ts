import type { ToolCall } from '@earendil-works/pi-ai'
import { Data, Option, Schema } from 'effect'

/** SDK scratch fields are ingress data absent from ToolCall's public shape. Grammar customInput
 * has no retained JSON text: jsonBuffer.input is the raw grammar, so it deliberately yields None.
 * Pi events.js:279 reports retained partialJson/partialArgs through whole-block replacements;
 * its toolcall_delta instead names a parsed arguments property, never the raw JSON buffer. */
const RawArguments = Schema.Union([
  Schema.Struct({ partialJson: Schema.String }),
  Schema.Struct({ partialArgs: Schema.String }),
])
const decodeRaw = Schema.decodeUnknownOption(RawArguments)

/** Decode only provider-retained JSON text; never stringify a parsed partial object. */
export function rawArguments(block: ToolCall): Option.Option<string> {
  return Option.map(decodeRaw(block), (value) =>
    'partialJson' in value ? value.partialJson : value.partialArgs,
  )
}

/** A provider edit cannot splice a second JSON text into one reader's already-sent prefix. */
export type ArgumentText = Data.TaggedEnum<{
  Empty: {}
  Growing: { readonly prefix: string }
  Stopped: { readonly prefix: string }
}>
export const ArgumentText = Data.taggedEnum<ArgumentText>()

/** The presentation delta carries its next ledger state; an empty suffix means no wire chunk. */
export type ArgumentDelta = { readonly state: ArgumentText; readonly delta: string }

/** Prefix growth emits only its suffix. Missing scratch at provider end retains the sent offset;
 * non-prefix edits freeze this call until final validated input replaces the client's partial. */
export function argumentDelta(previous: ArgumentText, raw: Option.Option<string>): ArgumentDelta {
  if (Option.isNone(raw) || ArgumentText.$is('Stopped')(previous))
    return { state: previous, delta: '' }
  const prefix = ArgumentText.$is('Empty')(previous) ? '' : previous.prefix
  if (!raw.value.startsWith(prefix)) return { state: ArgumentText.Stopped({ prefix }), delta: '' }
  return {
    state: ArgumentText.Growing({ prefix: raw.value }),
    delta: raw.value.slice(prefix.length),
  }
}

/** A shortened started call needs reset-step rebuilding; scratch deletion at message_end does not. */
export function argumentsShortened(previous: ArgumentText, block: ToolCall): boolean {
  if (ArgumentText.$is('Empty')(previous)) return false
  const raw = rawArguments(block)
  return Option.isSome(raw) && raw.value.length < previous.prefix.length
}

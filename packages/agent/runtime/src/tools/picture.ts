import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { Option, type Schema } from 'effect'

/** Pi native content keeps PNG bytes outside bounded JSON and persists them as model images. */
export function pictureResult(
  result: { output: Schema.Json; terminate: boolean },
  picture: Option.Option<string>,
) {
  const content: ToolResultMessage['content'] = [
    { type: 'text', text: JSON.stringify(result.output) },
  ]
  if (Option.isSome(picture))
    content.push({ type: 'image', mimeType: 'image/png', data: picture.value })
  return { content, details: result.output, terminate: result.terminate }
}

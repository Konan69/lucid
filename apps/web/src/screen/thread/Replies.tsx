import { Button } from '../../ui/button'

/**
 * The replies Vivid offered under its newest reply (`offeredReplies` in `@vivid/state`), as taps:
 * pressing one says its words as the Person's next message, through the same send the composer
 * uses. Claude Duet and ChatGPT draw their suggested replies the same way.
 *
 * Nothing removes them. The Thread draws them only under the newest reply while Vivid is not
 * working, so once the Person's message lands under it, or Vivid starts again, they are not drawn.
 *
 * Each is the control pill (32 px, fully round) on the page's own surface with the field's
 * hairline, so it reads as something to press and not as another bubble. They fade in as the
 * reply settles (`motion-fade`, 200 ms ease-out), the same moment as the stamp above them; they
 * appear once per reply, so nothing travels.
 */
export function Replies({
  replies,
  onSay,
}: {
  replies: ReadonlyArray<string>
  onSay: (words: string) => void
}) {
  return (
    <div className="motion-fade flex flex-wrap gap-1.5 ps-10 pt-1">
      {replies.map((words) => (
        <Button
          key={words}
          variant="outline"
          size="pill"
          className="bg-surface-0 text-title edge-field"
          onClick={() => onSay(words)}
        >
          <span aria-hidden className="text-ink-3">
            ↪
          </span>
          {words}
        </Button>
      ))}
    </div>
  )
}

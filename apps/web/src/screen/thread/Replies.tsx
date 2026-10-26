import { Button } from '../../ui/button'

/**
 * The replies Vivid offered under its newest reply (`offeredReplies` in `@vivid/state`), as taps:
 * pressing one says its words as the Person's next message, through the same send the composer
 * uses. Claude Duet and ChatGPT draw their suggested replies the same way.
 *
 * Nothing removes them. The Thread draws them only under the newest reply while Vivid is not
 * working, so once the Person's message lands under it, or Vivid starts again, they are not drawn.
 *
 * Each is the control pill (32 px, fully round): a light glass fill with the field's hairline and
 * no shadow, the "↪" character and one to three words, as Claude Duet draws its suggestions. They
 * slide in from the left one after another (`motion-offer`), the owner's approved mockup v8.
 */
export function Replies({
  replies,
  onSay,
}: {
  replies: ReadonlyArray<string>
  onSay: (words: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1 ps-10 pt-1">
      {replies.map((words, at) => (
        <Button
          key={words}
          variant="outline"
          size="pill"
          // One after another: 120 ms between replies (`motion-offer`).
          style={{ transitionDelay: `${at * 120}ms` }}
          className="motion-offer gap-1.25 ps-2.5 pe-3 text-body font-normal bg-surface-0/45 backdrop-blur-md shadow-none edge-field"
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

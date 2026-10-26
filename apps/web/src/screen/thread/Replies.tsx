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
          variant="glass"
          size="reply"
          // One after another: `motion-offer` waits 120 ms for each reply before this one.
          // SAFETY: React forwards this CSS custom property; `motion-offer` reads it.
          style={{ '--offer-at': at } as React.CSSProperties}
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

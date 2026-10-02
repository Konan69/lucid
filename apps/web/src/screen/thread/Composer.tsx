import { ArrowUp, Mic, Square } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { draft } from '../../data/drafts'
import { IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'

/**
 * Where a Person writes to Vivid. Enter sends, Shift+Enter makes a new line, and while Vivid is
 * working the send button becomes the way to stop it. What is typed is kept on this device for
 * the place it was typed in (`place`), so it is still here after leaving and coming back; the
 * Thread the composer belongs to decides what sending means.
 */
export function Composer({
  place,
  placeholder = 'Message Vivid',
  working,
  onSend,
  onStop,
  onTyping,
  onTalk,
  above,
}: {
  /** Where this composer's unsent words are kept: one Thread, or the start of a new one. */
  place: string
  placeholder?: string
  working: boolean
  onSend: (message: string) => void
  onStop: () => void
  /** Told when the Person starts or stops having something typed, for the people watching. */
  onTyping?: (typing: boolean) => void
  onTalk?: () => void
  /** Something anchored above the composer: a live call, a notice. */
  above?: ReactNode
}) {
  const [message, setMessage] = useState(() => draft.in(place))
  const empty = message.trim().length === 0

  /** The field and the kept draft change together, so what is on screen is what is saved. */
  function write(next: string) {
    setMessage(next)
    draft.keep(place, next)
  }

  function submit() {
    const body = message.trim()
    if (body.length === 0) return
    write('')
    if (onTyping !== undefined) onTyping(false)
    onSend(body)
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-3 sm:px-6 sm:pb-5">
      <div className="mx-auto w-full max-w-(--thread-max-w)">
        <div className="relative rounded-composer bg-surface-3 smooth-shadow-ring-sm">
          {above !== undefined && above !== null && (
            <div className="absolute inset-x-0 bottom-full z-40 mb-3 flex justify-center sm:justify-end">
              {above}
            </div>
          )}
          <textarea
            // What is typed here is kept for its place, so leaving by a shortcut loses nothing.
            data-keeps-draft
            rows={1}
            aria-label={placeholder}
            placeholder={placeholder}
            value={message}
            onChange={(event) => {
              const next = event.target.value
              // Only the edges are reported: starting to type and clearing the field.
              if (onTyping !== undefined && (next.length === 0) !== (message.length === 0)) {
                onTyping(next.length > 0)
              }
              write(next)
            }}
            onKeyDown={(event) => {
              // While an input method is composing, Enter picks a candidate; it does not send.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
            className="block field-sizing-content max-h-60 w-full resize-none bg-transparent px-5 pt-4 pb-2 text-body text-ink outline-none placeholder:text-ink-4"
          />
          <div className="flex items-center gap-1 px-3 pb-3">
            <span className="flex-1" />
            {onTalk !== undefined && (
              <IconButton label="Talk to Vivid" onClick={onTalk}>
                <Mic className="size-4" />
              </IconButton>
            )}
            <button
              aria-label={working ? 'Stop' : 'Send'}
              disabled={!working && empty}
              onClick={() => (working ? onStop() : submit())}
              className={cn(
                'inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-ink-on-accent smooth-shadow-xs transition-press duration-(--dur-fast) active:scale-96 disabled:cursor-not-allowed disabled:opacity-40',
                working ? 'bg-danger' : 'bg-accent hover:bg-accent-hover',
              )}
            >
              {working ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

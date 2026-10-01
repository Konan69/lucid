import { ArrowUp, Mic, Square } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'

/**
 * Where a Person writes to Vivid. Enter sends, Shift+Enter makes a new line, and while Vivid is
 * working the send button becomes the way to stop it. The field keeps its own draft; the Thread
 * it belongs to decides what sending means.
 */
export function Composer({
  initialMessage = '',
  placeholder = 'Message Vivid',
  working,
  onSend,
  onStop,
  onTyping,
  onTalk,
  above,
}: {
  initialMessage?: string
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
  const [message, setMessage] = useState(initialMessage)
  const empty = message.trim().length === 0

  function submit() {
    const body = message.trim()
    if (body.length === 0) return
    setMessage('')
    if (onTyping !== undefined) onTyping(false)
    onSend(body)
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-3 sm:px-6 sm:pb-5">
      <div className="mx-auto w-full max-w-(--thread-max-w)">
        <div className="relative rounded-composer bg-surface-3 smooth-shadow-ring-md">
          {above !== undefined && above !== null && (
            <div className="absolute inset-x-0 bottom-full z-40 mb-3 flex justify-center sm:justify-end">
              {above}
            </div>
          )}
          <textarea
            rows={1}
            placeholder={placeholder}
            value={message}
            onChange={(event) => {
              const next = event.target.value
              // Only the edges are reported: starting to type and clearing the field.
              if (onTyping !== undefined && (next.length === 0) !== (message.length === 0)) {
                onTyping(next.length > 0)
              }
              setMessage(next)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
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

import { BorderBeam } from 'border-beam'
import { ArrowUp, Mic, Paperclip, Square } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { draft } from '../../data/drafts'
import { writing } from '../../data/life'
import { theme } from '../../data/theme'
import { IconButton } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { attachable, Attached, useAttachments, type Picture } from './Attach'

/**
 * Where a Person writes to Vivid. Enter sends, Shift+Enter makes a new line, and while Vivid is
 * working the send button becomes the way to stop it. What is typed is kept for the place it was
 * typed in (`place`), on this device and for the Person's other devices (`data/drafts.ts`), so it
 * is still here after leaving and coming back; the Thread the composer belongs to decides what
 * sending means.
 */
export function Composer({
  place,
  placeholder = 'Message Vivid',
  working,
  onSend,
  pictures = false,
  onStop,
  onTyping,
  onTalk,
  above,
}: {
  /** Where this composer's unsent words are kept: one Thread, or the start of a new one. */
  place: string
  placeholder?: string
  working: boolean
  /** The words, and any pictures attached to them. */
  onSend: (message: string, pictures: ReadonlyArray<Picture>) => void
  /** Whether a picture can be sent from here: only where the message goes straight to Vivid. */
  pictures?: boolean
  onStop: () => void
  /** Told when the Person starts or stops having something typed, for the people watching. */
  onTyping?: (typing: boolean) => void
  onTalk?: () => void
  /** Something anchored above the composer: a live call, a notice. */
  above?: ReactNode
}) {
  // The field draws the kept draft and holds no copy of it, so what is on screen is what is kept,
  // and words typed on another device arrive in a composer that is already open.
  const message = useSyncExternalStore(draft.subscribe, () => draft.in(place))
  const attached = useAttachments(pictures)
  // Something to send: words, or a file that has arrived. A file still on its way holds the send.
  const empty = (message.trim().length === 0 && attached.kept === 0) || attached.sending
  const shown = useSyncExternalStore(theme.subscribe, theme.shown)

  const write = (next: string) => draft.keep(place, next)

  function submit() {
    if (empty) return
    // The files that made it are named under the words, so Vivid knows what to read; a message
    // that is only files still says what is wanted of them.
    const words = message.trim().length === 0 ? 'Have a look at this.' : message.trim()
    const taken = attached.take()
    const body = [words, ...taken.lines].join('\n\n')
    write('')
    // Sent: the Person has stopped writing, and Vivid's face turns from listening to the work.
    writing.stopped()
    if (onTyping !== undefined) onTyping(false)
    onSend(body, taken.pictures)
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-3 sm:px-6 sm:pb-5">
      <div className="mx-auto w-full max-w-(--thread-max-w)">
        <div className="relative">
          {above !== undefined && above !== null && (
            <div className="absolute inset-x-0 bottom-full z-40 mb-3 flex justify-center sm:justify-end">
              {above}
            </div>
          )}
          {/* While Vivid works, a light travels the composer's edge: the place the Person would
              write next is the place that says something is happening. It fades in over the
              library's own 0.6 s, so a reply that starts at once never shows it. The beam clips
              what it wraps, which is why whatever is anchored above sits outside it. */}
          {/* The edge and the lift are drawn by this wrapper, outside the beam: both are shadows
              that fall outside the box, and the beam clipped them away, which left the composer
              a white box on a white page with no edge at all. */}
          <div className="rounded-composer lift edge-field">
            <BorderBeam active={working} colorVariant="ocean" strength={0.7} theme={shown}>
              {/* The beam reads its corner radius from the one element it wraps. */}
              <div
                className="rounded-composer bg-surface-3"
                // A file dropped anywhere on the composer is attached, the same as picking it.
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  attached.add(Array.from(event.dataTransfer.files))
                }}
              >
                <Attached files={attached.files} onRemove={attached.remove} />
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
                    // Vivid's face listens while the Person writes (`data/life.ts`).
                    if (next.length > 0) writing.heard()
                    else writing.stopped()
                  }}
                  onKeyDown={(event) => {
                    // While an input method is composing, Enter picks a candidate; it does not send.
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                  className="block field-sizing-content max-h-60 min-h-14 w-full resize-none bg-transparent px-5 pt-4 pb-1 text-body text-ink outline-none placeholder:text-ink-3"
                />
                <div className="flex items-center gap-1 px-3 pb-3">
                  <Pick accept={attachable(pictures)} onPick={attached.add} />
                  <span className="flex-1" />
                  {onTalk !== undefined && (
                    <IconButton label="Talk to Vivid" onClick={onTalk}>
                      <Mic className="size-4" />
                    </IconButton>
                  )}
                  <SendOrStop working={working} empty={empty} onStop={onStop} onSend={submit} />
                </div>
              </div>
            </BorderBeam>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The one round button of the composer. It sends; while Vivid works it is the way to stop it.
 * The two marks take turns in the one place: the one going shrinks away as the one coming grows
 * in (`motion-swap`), so the button is seen to change what it does instead of being swapped for
 * another.
 */
function SendOrStop({
  working,
  empty,
  onStop,
  onSend,
}: {
  working: boolean
  /** Nothing to send yet. */
  empty: boolean
  onStop: () => void
  onSend: () => void
}) {
  return (
    <button
      aria-label={working ? 'Stop' : 'Send'}
      disabled={!working && empty}
      onClick={() => (working ? onStop() : onSend())}
      className={cn(
        // With nothing to send it is a quiet disc, not a faded accent: an accent at 40%
        // reads as a broken button, a neutral one reads as "write something first".
        'relative inline-flex size-9 motion-press cursor-pointer items-center justify-center rounded-full text-primary-foreground disabled:cursor-not-allowed disabled:bg-wash-pressed disabled:text-ink-4',
        working ? 'bg-ink text-surface-0 hover:bg-ink-2' : 'bg-primary hover:bg-primary-hover',
      )}
    >
      <Square data-shown={working} className="absolute size-3.5 motion-swap fill-current" />
      <ArrowUp data-shown={!working} className="absolute size-4 motion-swap" strokeWidth={2.25} />
    </button>
  )
}

/**
 * The paperclip: picks documents to attach. The same file can be picked again once taken off.
 *
 * It is a label around the browser's own file input, which is what opens the file picker, so it
 * cannot be an `IconButton`; the label is the tooltip's trigger. Focus lands on the input inside
 * it and is heard by the label, so the tooltip shows from the keyboard as well.
 */
function Pick({
  accept,
  onPick,
}: {
  accept: string
  onPick: (files: ReadonlyArray<File>) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="inline-flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) focus-within:bg-wash-hover hover:bg-wash-hover hover:text-ink" />
        }
      >
        <Paperclip className="size-4" />
        <span className="sr-only">Attach a file</span>
        <input
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          onChange={(event) => {
            const picked = event.currentTarget.files
            if (picked !== null) onPick(Array.from(picked))
            event.currentTarget.value = ''
          }}
        />
      </TooltipTrigger>
      <TooltipContent>Attach a file</TooltipContent>
    </Tooltip>
  )
}

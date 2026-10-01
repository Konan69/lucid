import { MessageSquareText, Mic, MicOff, X } from 'lucide-react'
import { useState, useSyncExternalStore, type ButtonHTMLAttributes } from 'react'
import { teammate } from '../call/script'
import { Ring, type CallSession } from '../call/session'
import { VoicePhase, type VoiceControls } from '../call/voice'
import { cn } from '../ui/cn'
import { Face } from '../ui/Face'

const BAR_COUNT = 36

/**
 * Bar heights (0–1) for one beat. A cheap integer hash of beat and bar keeps the shape stable
 * between beats and different on each, so the waveform moves only when a transcript updates,
 * never on a frame loop. The ends taper so the shape reads as a voice, not noise.
 */
const barHeights = (beat: number) =>
  Array.from({ length: BAR_COUNT }, (_, bar) => {
    const hash = Math.imul(beat * 97 + bar * 31, 2654435761) >>> 0
    const taper = Math.sin(((bar + 0.5) / BAR_COUNT) * Math.PI)
    return 0.25 + 0.75 * taper * ((hash % 1000) / 1000)
  })

const barTone = VoicePhase.match({
  Connecting: () => 'bg-ink-4',
  Speaking: () => 'bg-success',
  Listening: () => 'bg-accent',
  Ended: () => 'bg-ink-4',
})

/** Round control under the pill; `tone` marks the destructive hang-up. */
export function RoundButton({
  label,
  tone = 'plain',
  active = false,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  tone?: 'plain' | 'danger' | 'answer'
  active?: boolean
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-11 cursor-pointer items-center justify-center rounded-full transition-press duration-(--dur-fast) active:scale-96 disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'plain' && 'bg-surface-2 text-ink-2 ring-line hover:bg-wash-hover hover:text-ink',
        tone === 'danger' && 'bg-danger text-ink-on-accent smooth-shadow-xs hover:opacity-90',
        tone === 'answer' && 'bg-success text-ink-on-accent smooth-shadow-xs hover:opacity-90',
        active && 'bg-wash-selected text-ink',
        className,
      )}
      {...rest}
    />
  )
}

/**
 * Vivid's voice card: the face and a waveform in a pill, captions, mute and hang-up. Shared by
 * the laptop talk and the phone call. `ended` is the line shown once the call is over.
 */
export function VoiceCard({
  voice,
  ended,
  onClose,
}: {
  voice: VoiceControls
  ended: string
  onClose: () => void
}) {
  const { phase, captions, live, beat, muted } = useSyncExternalStore(
    voice.subscribe,
    voice.getSnapshot,
  )
  const [showCaptions, setShowCaptions] = useState(true)
  const latest = live.length > 0 ? live : captions.at(-1)?.text
  const over = VoicePhase.guards.Ended(phase)
  const status = VoicePhase.match(phase, {
    Connecting: () => 'Connecting…',
    Speaking: () => undefined,
    Listening: () => undefined,
    Ended: () => ended,
  })

  return (
    <div
      role="dialog"
      aria-label="Talking with Vivid"
      className="w-full max-w-sm animate-fade-in rounded-[28px] bg-surface-1 p-3 smooth-shadow-xs ring-line"
    >
      <div className="flex h-16 items-center gap-3 rounded-full bg-surface-2 px-3">
        <Face size={40} mood={VoicePhase.guards.Speaking(phase) ? 'happy' : 'neutral'} />
        {status !== undefined ? (
          <p
            className="min-w-0 flex-1 truncate text-label font-title text-ink-2"
            aria-live="polite"
          >
            {status}
          </p>
        ) : (
          <span
            aria-hidden
            className="flex h-8 min-w-0 flex-1 items-center justify-center gap-0.75"
          >
            {barHeights(beat).map((height, bar) => (
              <i
                key={bar}
                className={cn(
                  'block w-0.75 rounded-full transition-[height] duration-(--dur-fast)',
                  barTone(phase),
                )}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            ))}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-center gap-3">
        <RoundButton
          label={showCaptions ? 'Hide captions' : 'Show captions'}
          active={showCaptions}
          onClick={() => setShowCaptions((shown) => !shown)}
        >
          <MessageSquareText className="size-4.5" />
        </RoundButton>
        <RoundButton
          label={muted ? 'Unmute' : 'Mute'}
          active={muted}
          disabled={over}
          onClick={voice.toggleMute}
        >
          {muted ? <MicOff className="size-4.5" /> : <Mic className="size-4.5" />}
        </RoundButton>
        <RoundButton
          label={over ? 'Close' : 'Hang up'}
          tone="danger"
          onClick={() => {
            voice.hangUp()
            onClose()
          }}
        >
          <X className="size-5" />
        </RoundButton>
      </div>

      {showCaptions && latest !== undefined && (
        <p
          className={cn(
            'mt-3 px-2 pb-1 text-center text-label',
            live.length > 0 ? 'text-ink-3' : 'text-ink-2',
          )}
          aria-live="polite"
        >
          {latest}
        </p>
      )}
    </div>
  )
}

/** What the card says once the talk is over: whether Vivid got through to the teammate. */
const ringStatus = Ring.match({
  Pending: () => 'Call ended',
  Scheduled: () => `Calling ${teammate}…`,
  Sent: () => `Calling ${teammate}`,
  Failed: () => `Couldn’t reach ${teammate}`,
})

/** The laptop talk, floating just above the composer's Talk button. */
export function Call({ session, onClose }: { session: CallSession; onClose: () => void }) {
  const ring = useSyncExternalStore(session.subscribe, session.getRing)
  return <VoiceCard voice={session.voice} ended={ringStatus(ring)} onClose={onClose} />
}

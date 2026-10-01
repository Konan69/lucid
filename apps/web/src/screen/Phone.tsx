import { MessageSquareText, Mic, MicOff, Phone as PhoneIcon, X } from 'lucide-react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PhoneCallRequest } from '@vivid/contracts'
import { PhoneLine, PhoneScreen } from '../call/phone'
import { VoicePhase, type VoiceControls } from '../call/voice'
import { cn } from '../ui/cn'
import { Orb, type Loudness, type OrbMood } from '../ui/Orb'
import { RoundButton } from './Call'

/**
 * `/phone`: the Person's phone waiting for Vivid to call. Asleep until one tap arms it, then
 * waiting, ringing, and finally a full-screen call, laid out like a phone's own call screen:
 * who and status at the top, Vivid's face in the middle, controls in thumb reach at the bottom.
 */
export function Phone() {
  const [line] = useState(() => new PhoneLine())
  const screen = useSyncExternalStore(line.subscribe, line.getSnapshot)
  return (
    <PhoneView
      screen={screen}
      onArm={() => void line.arm()}
      onAnswer={line.answer}
      onIdle={line.idle}
    />
  )
}

/** The three bands of every phone screen: header, face, controls. */
function Layout({
  status,
  face,
  below,
  controls,
}: {
  status: string
  face: ReactNode
  below?: ReactNode
  controls: ReactNode
}) {
  return (
    <main className="flex h-full flex-col items-center bg-surface-0 px-6 pt-[max(4.5rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] text-center">
      <header className="flex flex-col items-center gap-1">
        <h1 className="text-[28px] leading-tight font-title text-ink">Vivid</h1>
        <p className="text-label text-ink-3 tabular-nums" aria-live="polite">
          {status}
        </p>
      </header>
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6">
        {face}
        {below}
      </div>
      <footer className="flex w-full items-start justify-center gap-10">{controls}</footer>
    </main>
  )
}

/** A big round call control with its label underneath, as on a phone's call screen. */
function CallControl({
  label,
  tone = 'plain',
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  tone?: 'plain' | 'danger' | 'answer'
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <RoundButton
        label={label}
        tone={tone}
        active={active}
        disabled={disabled}
        className="size-[68px]"
        onClick={onClick}
      >
        {children}
      </RoundButton>
      <span className="text-meta text-ink-3">{label}</span>
    </div>
  )
}

/** Screens with no call audio (waiting, ringing) pulse on the simulated curve. */
const simulated: Loudness = { _tag: 'Simulated' }

const orbMood = VoicePhase.match({
  Connecting: (): OrbMood => 'working',
  Speaking: (): OrbMood => 'speaking',
  Listening: (): OrbMood => 'resting',
  Ended: (): OrbMood => 'resting',
})

/** m:ss, as a phone shows a call's length. */
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/** The face shows who is talking; the header only says how the call is going, like a phone. */
const callStatus = (phase: VoicePhase, elapsed: number) =>
  VoicePhase.match(phase, {
    Connecting: () => 'Connecting…',
    Speaking: () => duration(elapsed),
    Listening: () => duration(elapsed),
    // A failure is shown rather than swallowed: a call that never connected must not look
    // like a call that simply finished.
    Ended: ({ failure }) =>
      failure === null ? `Call ended · ${duration(elapsed)}` : `Call failed · ${failure}`,
  })

/** The live call: the face reacts to who is talking, captions sit under it. */
function OnCall({ voice, onClose }: { voice: VoiceControls; onClose: () => void }) {
  const { phase, captions, live, muted, elapsed } = useSyncExternalStore(
    voice.subscribe,
    voice.getSnapshot,
  )
  const [showCaptions, setShowCaptions] = useState(true)
  // One object per call, so the orb's frame loop is not restarted on every render.
  const [loudness] = useState<Loudness>(() => ({ _tag: 'Measured', read: voice.loudness }))
  const over = VoicePhase.guards.Ended(phase)
  const latest = live.length > 0 ? live : captions.at(-1)?.text

  return (
    <Layout
      status={callStatus(phase, elapsed)}
      face={<Orb mood={orbMood(phase)} live={!over} loudness={loudness} size={240} />}
      below={
        showCaptions &&
        latest !== undefined && (
          <p
            className={cn(
              'min-h-[4.5em] max-w-xs text-body leading-relaxed',
              live.length > 0 ? 'text-ink-3' : 'text-ink-2',
            )}
            aria-live="polite"
          >
            {latest}
          </p>
        )
      }
      controls={
        <>
          <CallControl
            label="Captions"
            active={showCaptions}
            onClick={() => setShowCaptions((shown) => !shown)}
          >
            <MessageSquareText className="size-6" />
          </CallControl>
          <CallControl
            label={muted ? 'Unmute' : 'Mute'}
            active={muted}
            disabled={over}
            onClick={voice.toggleMute}
          >
            {muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
          </CallControl>
          <CallControl
            label={over ? 'Close' : 'End'}
            tone="danger"
            onClick={() => {
              voice.hangUp()
              onClose()
            }}
          >
            <X className="size-7" />
          </CallControl>
        </>
      }
    />
  )
}

/** The phone's screens, driven by props so the design canvas can show each one at rest. */
export function PhoneView({
  screen,
  onArm,
  onAnswer,
  onIdle,
}: {
  screen: PhoneScreen
  onArm: () => void
  onAnswer: (call: PhoneCallRequest) => void
  onIdle: () => void
}) {
  return PhoneScreen.$match(screen, {
    Asleep: () => (
      <Layout
        status="Keep this open and Vivid can call you"
        face={<Orb mood="resting" live={false} loudness={simulated} size={200} />}
        controls={
          <button
            onClick={onArm}
            className="h-14 w-full max-w-xs cursor-pointer rounded-full bg-accent text-title font-title text-ink-on-accent smooth-shadow-xs transition-press duration-(--dur-fast) hover:bg-accent-hover active:scale-96"
          >
            Be reachable
          </button>
        }
      />
    ),
    Blocked: ({ reason }) => (
      <Layout
        status={`Vivid needs the microphone to call you · ${reason}`}
        face={<Orb mood="resting" live={false} loudness={simulated} size={200} />}
        controls={
          <button
            onClick={onArm}
            className="h-14 w-full max-w-xs cursor-pointer rounded-full bg-accent text-title font-title text-ink-on-accent smooth-shadow-xs transition-press duration-(--dur-fast) hover:bg-accent-hover active:scale-96"
          >
            Try again
          </button>
        }
      />
    ),
    Waiting: () => (
      <Layout
        status="Vivid can reach you here"
        face={<Orb mood="resting" live={false} loudness={simulated} size={200} />}
        controls={<p className="text-meta text-ink-4">Keep this screen open</p>}
      />
    ),
    Incoming: ({ call }) => (
      <Layout
        status="is calling…"
        face={<Orb mood="working" live loudness={simulated} size={240} />}
        controls={
          <>
            <CallControl label="Decline" tone="danger" onClick={onIdle}>
              <X className="size-7" />
            </CallControl>
            <CallControl label="Answer" tone="answer" onClick={() => onAnswer(call)}>
              <PhoneIcon className="size-7" />
            </CallControl>
          </>
        }
      />
    ),
    Talking: ({ voice }) => <OnCall voice={voice} onClose={onIdle} />,
  })
}

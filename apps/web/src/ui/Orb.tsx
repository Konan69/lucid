import { faceGeometry } from '@vivid/marks'
import { useCallback } from 'react'
import { cn } from './cn'

/**
 * Vivid's face drawn as a dot-matrix disc, for the full-screen phone call: a round grid of accent
 * dots that breathes, ripples while Vivid speaks and swirls while connecting, with Vivid's two
 * eyes on top so it still reads as the same face as `Face`.
 *
 * Adapted from rare-ui's MatrixOrb (swamimalode07/rare-ui, `matrix-orb`); renamed to Vivid's
 * vocabulary and reworked for this repository's rules:
 * - No `useEffect`: the canvas loop starts in a ref callback and stops in its cleanup, and each
 *   frame reads the current mood from the canvas's `data-mood`, so React only sets an attribute.
 * - It repaints every frame only while `live` (a call ringing or in progress). Otherwise, and
 *   under reduced motion, it paints one still frame, because the repo bans continuously
 *   repainting animations outside a moment that earns them.
 */
export type OrbMood = 'resting' | 'speaking' | 'working'

const MOODS: readonly OrbMood[] = ['resting', 'speaking', 'working']
const TAU = Math.PI * 2

/** How large the disc sits per mood; the spring below eases between them. */
const SCALE: Record<OrbMood, number> = { resting: 0.9, speaking: 1, working: 0.93 }
const STIFFNESS = 180
const DAMPING = 26
/** Per-frame share (at 60 fps) by which mood weights move toward the current mood. */
const BLEND = 0.16

/** Three bright spots circling the disc while Vivid is connecting or working. */
const ORBITERS = [
  { radius: 0.62, speed: 2.2, phase: 0, spread: 0.42 },
  { radius: 0.4, speed: -1.7, phase: 2.1, spread: 0.36 },
  { radius: 0.8, speed: 1.15, phase: 4, spread: 0.34 },
]

/**
 * A voice-like loudness curve (0.22–1). Stands in for real audio where there is none, such as the
 * design canvas; a live call passes Vapi's measured loudness instead.
 */
const envelope = (t: number) => {
  const slow = 0.5 + 0.5 * Math.sin(t * 0.62 + 0.4)
  const fast = 0.5 + 0.5 * Math.sin(t * 1.9 + 1.1)
  return 0.22 + 0.78 * (0.45 + 0.55 * slow) * fast
}

/** Dot brightness (0–1) at normalised grid point (nx, ny), distance d from centre, time t. */
const intensity = (
  mood: OrbMood,
  point: { readonly d: number; readonly nx: number; readonly ny: number },
  t: number,
  amplitude: number,
) => {
  const { d, nx, ny } = point
  if (mood === 'speaking')
    return 0.32 + amplitude * (0.34 + 0.38 * (0.5 + 0.5 * Math.sin(d * 4.2 - t * 3)))
  if (mood === 'working') {
    const heat = ORBITERS.reduce((sum, o) => {
      const a = t * o.speed + o.phase
      const dx = nx - Math.cos(a) * o.radius
      const dy = ny - Math.sin(a) * o.radius
      return sum + Math.exp(-(dx * dx + dy * dy) / (o.spread * o.spread))
    }, 0)
    return 0.26 + 0.8 * Math.min(1, heat)
  }
  // Resting breathes slowly; measured loudness (the Person talking) adds a softer ripple on top.
  return (
    0.62 + 0.12 * Math.sin(t * 1.05 - d * 2.4) + 0.3 * amplitude * (0.5 + 0.5 * Math.sin(d * 4.2 - t * 3))
  )
}

/** Where the ripple's loudness comes from. */
export type Loudness =
  | { readonly _tag: 'Measured'; readonly read: () => number }
  | { readonly _tag: 'Simulated' }

/** Rise fast and fall slowly, per frame at 60 fps, so the ripple tracks syllables smoothly. */
const ATTACK = 0.22
const RELEASE = 0.08

const isMood = (value: string | undefined): value is OrbMood =>
  MOODS.some((mood) => mood === value)

/**
 * Starts painting `canvas` and returns the cleanup that stops it. `live` decides between a frame
 * loop and a single still frame; the colour comes from the canvas's CSS `color` (a token class).
 */
const paint = (canvas: HTMLCanvasElement, size: number, live: boolean, loudness: Loudness) => {
  const context = canvas.getContext('2d')
  if (context === null) return () => undefined
  const ratio = Math.min(devicePixelRatio, 4)
  const buffer = Math.round(size * ratio)
  canvas.width = canvas.height = buffer
  context.scale(buffer / size, buffer / size)
  context.fillStyle = getComputedStyle(canvas).color

  const grid = 13
  const half = (grid - 1) / 2
  const spacing = (size * 0.74) / (grid - 1)
  const maxRadius = spacing * 0.6
  const center = size / 2
  const moodNow = (): OrbMood => (isMood(canvas.dataset.mood) ? canvas.dataset.mood : 'resting')
  const weights: Record<OrbMood, number> = { resting: 0, speaking: 0, working: 0 }
  weights[moodNow()] = 1

  // Vapi reports speech loudness low (about 0–0.5), so it is stretched to fill the ripple.
  // Simulated loudness only animates speaking; a simulated resting orb just breathes.
  const target = (t: number, mood: OrbMood) => {
    if (loudness._tag === 'Measured') return Math.min(1, loudness.read() * 2.2)
    return mood === 'speaking' ? envelope(t) : 0
  }

  const draw = (t: number, scale: number, amplitude: number) => {
    context.clearRect(0, 0, size, size)
    for (let iy = 0; iy < grid; iy++) {
      for (let ix = 0; ix < grid; ix++) {
        const nx = (ix - half) / half
        const ny = (iy - half) / half
        const d = Math.hypot(nx, ny)
        // 1.12 rather than the square's 1.41 corner is what makes the outline round.
        if (d > 1.12) continue
        const blended = MOODS.reduce(
          (sum, mood) => sum + weights[mood] * intensity(mood, { d, nx, ny }, t, amplitude),
          0,
        )
        const radius = maxRadius * Math.exp(-d * d * 1.7) * Math.min(1, Math.max(0, blended)) * scale
        // Anything under half a device pixel renders as haze, not a dot.
        if (radius * ratio < 0.5) continue
        context.beginPath()
        context.arc(center + (ix - half) * spacing * scale, center + (iy - half) * spacing * scale, radius, 0, TAU)
        context.fill()
      }
    }
  }

  const still = !live || matchMedia('(prefers-reduced-motion: reduce)').matches
  if (still) {
    draw(0, SCALE[moodNow()], target(0, moodNow()))
    return () => undefined
  }

  let t = 0
  let scale = SCALE[moodNow()]
  let velocity = 0
  let amplitude = 0
  let last = performance.now()
  let frame = 0
  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    t += dt
    const mood = moodNow()
    const step = 1 - Math.pow(1 - BLEND, dt * 60)
    for (const each of MOODS) weights[each] += ((each === mood ? 1 : 0) - weights[each]) * step
    velocity += (-STIFFNESS * (scale - SCALE[mood]) - DAMPING * velocity) * dt
    scale += velocity * dt
    const goal = target(t, mood)
    amplitude += (goal - amplitude) * (1 - Math.pow(1 - (goal > amplitude ? ATTACK : RELEASE), dt * 60))
    draw(t, scale, amplitude)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}

export function Orb({
  mood,
  live,
  loudness,
  size = 240,
  className,
}: {
  mood: OrbMood
  loudness: Loudness
  /** Animate every frame; only while a call is ringing or in progress. */
  live: boolean
  size?: number
  className?: string
}) {
  const eyes = faceGeometry(size * 0.62, mood === 'speaking' ? 'happy' : 'neutral')
  // Stable per size and liveness, so a mood change re-renders without restarting the loop; a
  // change to either restarts it through the returned cleanup.
  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => (canvas === null ? undefined : paint(canvas, size, live, loudness)),
    [size, live, loudness],
  )
  return (
    <span
      role="img"
      aria-label="Vivid"
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <canvas
        ref={attach}
        data-mood={mood}
        aria-hidden
        className="block text-accent"
        style={{ width: size, height: size }}
      />
      <span
        aria-hidden
        className="absolute flex items-center"
        style={{ top: `${size * 0.19 + eyes.eyeTopFraction * size * 0.62}px`, gap: eyes.eyeGap }}
      >
        {/* `face-eye` supplies the eye colour; inline size wins over its custom properties. */}
        <i
          className="block face-eye -rotate-6 rounded-full"
          style={{ width: eyes.eyeWidth, height: eyes.eyeHeight }}
        />
        <i
          className="block face-eye rotate-6 rounded-full"
          style={{ width: eyes.eyeWidth, height: eyes.eyeHeight }}
        />
      </span>
    </span>
  )
}

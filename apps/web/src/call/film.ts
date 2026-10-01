/**
 * Films the phone's call as real video with sound, and streams it to the server while the call
 * runs. What it films is composed here rather than captured from the screen: Vivid's orb, the
 * status and the live caption, painted onto one canvas. Phone browsers cannot screen-record a
 * web page, so the page films itself, which also keeps the framing clean enough to drop straight
 * into an edit.
 *
 * Audio is the call itself: Vivid's voice from the element Vapi plays it through, mixed with the
 * Person's microphone.
 * Source: https://developer.mozilla.org/docs/Web/API/MediaStream_Recording_API
 */

/** Portrait, tall enough to read the captions when it is overlaid on a laptop capture. */
const WIDTH = 720
const HEIGHT = 1280
/** Encoded video is posted this often, so a call that ends badly still leaves a file. */
const chunkMs = 2_000

/** The first container this browser can encode; Safari does MP4, Chrome and Firefox WebM. */
const container = () =>
  ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  )

/** What the film shows, read once per frame from the live call. */
export interface Scene {
  /** The orb canvas already painting on screen; drawn into the film frame. */
  readonly orb: () => HTMLCanvasElement | null
  readonly status: () => string
  readonly caption: () => string
}

/** Wraps a caption to the film's width, longest-fit first, and keeps the last three lines. */
const wrap = (context: CanvasRenderingContext2D, text: string, width: number) => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line.length === 0 ? word : `${line} ${word}`
    if (context.measureText(next).width > width && line.length > 0) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line.length > 0) lines.push(line)
  return lines.slice(-3)
}

/** Paints one frame: name, status, the orb, and the caption beneath it. */
const frame = (context: CanvasRenderingContext2D, scene: Scene, accent: string, ink: string) => {
  context.fillStyle = '#0b0b0c'
  context.fillRect(0, 0, WIDTH, HEIGHT)
  context.textAlign = 'center'

  context.fillStyle = ink
  context.font = '600 44px system-ui, sans-serif'
  context.fillText('Vivid', WIDTH / 2, 150)
  context.fillStyle = accent
  context.font = '400 30px system-ui, sans-serif'
  context.fillText(scene.status(), WIDTH / 2, 200)

  const orb = scene.orb()
  if (orb !== null) {
    const size = 460
    context.drawImage(orb, (WIDTH - size) / 2, (HEIGHT - size) / 2 - 80, size, size)
  }

  context.fillStyle = ink
  context.font = '400 34px system-ui, sans-serif'
  const caption = scene.caption()
  if (caption.length > 0) {
    const lines = wrap(context, caption, WIDTH - 120)
    lines.forEach((line, index) => {
      context.fillText(line, WIDTH / 2, HEIGHT - 300 + index * 46)
    })
  }
}

/** A running film: give it Vivid's audio when the call connects, stop it when the call ends. */
export interface Film {
  readonly name: string
  /** Vapi creates the element that plays Vivid only once a call connects. */
  readonly attachVoice: (element: HTMLAudioElement) => void
  readonly stop: () => void
}

/**
 * Starts filming, silently: no control, no indicator, nothing in the frame that says recording.
 * It begins the moment the phone rings, so the ringing screen is in the film too.
 */
export async function film(scene: Scene): Promise<Film> {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  const type = container()
  if (context === null || type === undefined)
    return { name: '', attachVoice: () => undefined, stop: () => undefined }

  const styles = getComputedStyle(document.documentElement)
  const accent = styles.getPropertyValue('--accent').trim()
  const ink = styles.getPropertyValue('--ink').trim()

  let painting = 0
  const paint = () => {
    frame(context, scene, accent.length > 0 ? accent : '#7c6cff', ink.length > 0 ? ink : '#ffffff')
    painting = requestAnimationFrame(paint)
  }
  painting = requestAnimationFrame(paint)

  // Vivid's voice and the Person's microphone are mixed into one track, so the film has both
  // sides of the call rather than only what the phone's speaker emitted.
  const audio = new AudioContext()
  const mixed = audio.createMediaStreamDestination()
  // The microphone was granted when the phone was armed; if it is refused now, the film keeps
  // Vivid's side of the call rather than failing altogether.
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
  if (microphone !== null) audio.createMediaStreamSource(microphone).connect(mixed)

  const stream = canvas.captureStream(30)
  for (const track of mixed.stream.getAudioTracks()) stream.addTrack(track)

  const name = `phone-${new Date().toISOString().replaceAll(':', '-').slice(0, 19).toLowerCase()}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`
  const recorder = new MediaRecorder(stream, { mimeType: type })
  // Chunks are appended to one file on the server, so they must arrive in the order they were
  // encoded: two POSTs in flight at once can land the later one first and corrupt the video.
  // Each upload therefore waits for the one before it.
  let uploads = Promise.resolve()
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return
    const chunk = event.data
    uploads = uploads.then(() =>
      // Deliberately not `keepalive`: Chrome caps keepalive request bodies at 64 KB across the
      // origin, and video chunks pass that within seconds, so every chunk after the first was
      // being rejected and the film was left as a header with no picture in it.
      fetch(`/api/recordings/${name}`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: chunk,
      })
        .then(() => undefined)
        .catch(() => undefined),
    )
  }
  recorder.start(chunkMs)

  return {
    name,
    attachVoice: (element) => {
      // Vapi plays Vivid by assigning a MediaStream to the element's `srcObject`, and
      // `createMediaElementSource` captures nothing from an element fed that way — it reads the
      // element's own decoded output, which a stream-backed element does not produce. The film
      // came back with only the Person's microphone on it because of this. Taking the stream
      // directly is the supported route; the element keeps playing to the speakers untouched,
      // so nothing needs reconnecting for the Person to hear Vivid.
      // Source: https://developer.mozilla.org/docs/Web/API/AudioContext/createMediaStreamSource
      const stream = element.srcObject
      if (stream instanceof MediaStream) {
        audio.createMediaStreamSource(stream).connect(mixed)
        return
      }
      const voice = audio.createMediaElementSource(element)
      voice.connect(mixed)
      voice.connect(audio.destination)
    },
    stop: () => {
      cancelAnimationFrame(painting)
      recorder.stop()
      for (const track of microphone?.getTracks() ?? []) track.stop()
      void audio.close()
    },
  }
}

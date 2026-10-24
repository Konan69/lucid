import { Duration, Effect, Layer, ManagedRuntime, Option } from 'effect'
import { Notes, NotesSettings, layer } from './notes.ts'
import { notesDirectory } from './settings.ts'

let current: Option.Option<ManagedRuntime.ManagedRuntime<Notes, never>> = Option.none()

/** A process can stop and start Flue repeatedly; create a fresh lazy owner after each stop. */
const owner = () => {
  if (Option.isSome(current)) return current.value
  const runtime = ManagedRuntime.make(
    layer(
      NotesSettings.make({
        directory: notesDirectory,
        capacity: 64,
        idle: Duration.minutes(1),
      }),
    ),
  )
  current = Option.some(runtime)
  return runtime
}

/** Share the built Notes authority across independent framework calls, without owning its close. */
export const notesLayer = Layer.unwrap(
  Effect.sync(() => Layer.effectContext(owner().contextEffect)),
)

/** Detach first: no later call can receive the disposed runtime, even during store finalization. */
export const closeNotes = Effect.suspend(() => {
  const closing = current
  current = Option.none()
  return Option.match(closing, {
    onNone: () => Effect.void,
    onSome: (runtime) => runtime.disposeEffect,
  })
})

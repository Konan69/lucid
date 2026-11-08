import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import type { ArtifactId } from '@vivid/contracts'
import { artifacts, revising } from '@vivid/state'
import { Effect, Layer, Predicate, Result } from 'effect'
import { running } from './app'
import { engine } from './runtime'

/**
 * Artifacts on the web: one Artifact and its history, the Person's shelf of them, the editor that
 * revises a document, and the ways a file leaves the page (opened in a tab, saved to disk).
 *
 * Each is a live query on the app's socket (`WatchArtifact`, `WatchArtifactShelf`), so a version
 * Vivid adds while a card or the viewer is on screen shows there at once.
 */

/** Which version a reader asked for: a named one, or whichever is newest. */
export type Asked =
  | { readonly id: ArtifactId; readonly version: number }
  | { readonly id: ArtifactId }

/** One Artifact, at the version asked for, with every version there is. */
export const artifactLive = engine.family(
  (asked: Asked) => ('version' in asked ? `${asked.id}@${asked.version}` : asked.id),
  (client, asked) => client.WatchArtifact(asked),
)

/** Every Artifact in a Thread the Person can reach here, for the Library. */
export const shelfLive = engine.query((client) => client.WatchArtifactShelf())

/**
 * The document editor, one for the page (`@vivid/state` `revising`). A save is a new version made
 * from the one the Person started on; the server refuses it with `ArtifactChanged` when the
 * document moved meanwhile, which the editor tells apart from any other refusal.
 */
const reviser = revising.make(
  Layer.succeed(revising.Reviser, {
    revise: Effect.fn('Artifact.revise')(function* (revision: revising.Revision) {
      const result = yield* running(
        VividRpcClient.use((client) =>
          client.ReviseArtifact({ id: revision.id, from: revision.from, body: revision.body }),
        ),
      )
      if (Result.isSuccess(result)) return yield* Effect.void
      const failure = result.failure
      // The document moved meanwhile is told apart from every other refusal.
      return yield* Predicate.isTagged(failure, 'ArtifactChanged')
        ? Effect.fail(new revising.Moved({ revision, version: failure.version }))
        : Effect.fail(new revising.Unsaved({ revision }))
    }),
  }),
)

// The viewer is a dialog; a refusal outlives it being closed and opened again.
engine.registry.mount(reviser.reading)

/** Where the editor stands, for every screen that opens a document. */
export const useRevising = () => useAtomValue(reviser.reading)

/** The Person pressed Edit on a document at the version they are reading. */
export const editDocument = (id: ArtifactId, from: number) =>
  engine.registry.set(reviser.send, reviser.edit({ id, from }))

/** The Person closed the editor; what they typed is dropped. */
export const closeEditor = () => engine.registry.set(reviser.send, reviser.close())

/** Save, with a body the editor already checked. A second press while saving is not taken. */
export const saveDocument = (body: string) =>
  engine.registry.set(
    reviser.send,
    reviser.save({ attempt: revising.AttemptId.make(crypto.randomUUID()), body }),
  )

/**
 * Saves a document's text to disk as Markdown. The text is already on the page, so nothing is
 * asked of the server; the address is let go once the browser has the click.
 */
export const downloadDocument = (title: string, body: string) => {
  const address = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }))
  const anchor = document.createElement('a')
  anchor.href = address
  anchor.download = artifacts.documentFileName(title)
  anchor.click()
  // The click has started the download by the time this runs; the address is not read again.
  queueMicrotask(() => URL.revokeObjectURL(address))
}

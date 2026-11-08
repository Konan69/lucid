import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import type { ArtifactId } from '@vivid/contracts'
import { opening, revising, type makeLive } from '@vivid/state'
import { Effect, Layer, Predicate, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { openArtifactFile, shareMarkdown } from './documents'
import { confirm, tick } from './haptics'
import { useLiveData, type LiveData } from './live'
import type { SignedIn } from './session'

/**
 * Artifacts on the phone: which version a reader asked for, and the editor that revises a
 * document by hand (`@vivid/state` `revising`), one machine for the session as the web app has
 * one for the page. The live queries themselves are in `data/live.ts` beside every other.
 */

/** Which version a reader asked for: a named one, or whichever is newest. */
export type Asked =
  | { readonly id: ArtifactId; readonly version: number }
  | { readonly id: ArtifactId }

/** The key one Artifact's live query is kept under. */
export const askedKey = (asked: Asked) =>
  'version' in asked ? `${asked.id}@${asked.version}` : asked.id

/**
 * The session's document editor. A save is a new version made from the one the Person started
 * on; the server refuses it with `ArtifactChanged` when the document moved meanwhile, which the
 * editor tells apart from any other refusal.
 */
const makeRevising = (engine: ReturnType<typeof makeLive>) => {
  const reviser = revising.make(
    Layer.succeed(revising.Reviser, {
      revise: Effect.fn('Artifact.revise')(function* (revision: revising.Revision) {
        const result = yield* engine.run(
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
  // The sheet closing does not lose a refusal or what was typed: the session holds the machine.
  engine.registry.mount(reviser.reading)
  return reviser
}

/** Where the editor stands. */
export const useRevising = () => useAtomValue(useLiveData().artifacts.revising.reading)

/** The Person pressed Edit on a document at the version they are reading. */
export const editDocument = (data: LiveData, id: ArtifactId, from: number) =>
  data.registry.set(data.artifacts.revising.send, data.artifacts.revising.edit({ id, from }))

/** The Person closed the editor; what they typed is dropped. */
export const closeEditor = (data: LiveData) =>
  data.registry.set(data.artifacts.revising.send, data.artifacts.revising.close())

/** Save, with a body the editor already checked. A second press while saving is not taken. */
export const saveDocument = (data: LiveData, body: string) => {
  confirm()
  data.registry.set(
    data.artifacts.revising.send,
    data.artifacts.revising.save({ attempt: revising.AttemptId.make(randomUUID()), body }),
  )
}

/**
 * Handing a file to another app (`@vivid/state` `opening`), one for the session: a file Vivid
 * made is downloaded with the session's token and given to the share sheet; a document is
 * written as Markdown and given to it. What went wrong is the documents module's own sentence.
 */
const makeOpening = (engine: ReturnType<typeof makeLive>, session: SignedIn) => {
  const opener = opening.make(
    Layer.succeed(opening.Opener, {
      open: (target: opening.Target) =>
        opening.Source.match(target.source, {
          Stored: ({ path }) => openArtifactFile(session, path, target.name),
          Written: ({ text }) => shareMarkdown(target.name, text),
        }).pipe(
          Effect.asVoid,
          Effect.mapError((failure) => new opening.Unopened({ target, message: failure.message })),
        ),
    }),
  )
  engine.registry.mount(opener.reading)
  return opener
}

/** Where handing a file on stands, for every card and viewer. */
export const useOpening = () => useAtomValue(useLiveData().artifacts.opening.reading)

/** The Person pressed Share on a file or a document. A press while one is on its way is refused. */
export const openFile = (
  data: LiveData,
  file: { readonly key: string; readonly name: string; readonly source: opening.Source },
) => {
  tick()
  data.registry.set(
    data.artifacts.opening.send,
    data.artifacts.opening.open({ attempt: opening.AttemptId.make(randomUUID()), ...file }),
  )
}

/**
 * Everything about Artifacts the session keeps: one Artifact at the version asked for with every
 * version there is, the Person's shelf of them for the Library, and the two machines.
 */
export const makeArtifacts = (engine: ReturnType<typeof makeLive>, session: SignedIn) => ({
  one: engine.family(askedKey, (client, asked: Asked) => client.WatchArtifact(asked)),
  shelf: engine.query((client) => client.WatchArtifactShelf()),
  revising: makeRevising(engine),
  opening: makeOpening(engine, session),
})

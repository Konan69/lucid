import {
  ArtifactListResponse,
  ArtifactShelfResponse,
  type InspectArtifactFileRequest,
  type PublishArtifactFileRequest,
  ArtifactResponse,
  type ArtifactId,
  type GetArtifactRequest,
  type ReadDocumentRequest,
  type ReviseArtifactRequest,
  type ThreadId,
  type WriteDocumentRequest,
} from '@vivid/contracts'
import { Effect, Stream } from 'effect'
import {
  requireActor,
  requirePerson,
  requireRun,
  requireVivid,
  type Actor,
} from '../auth/access.ts'
import { Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { find } from './history.ts'
import { ArtifactStore } from './store.ts'
import { inspectArtifactFile, publishArtifactFile } from './files.ts'

/** Listing and watching share the same Thread access check, repeated after each invalidation. */
const load = Effect.fn('Artifacts.load')(function* (actor: Actor, threadId: ThreadId) {
  return ArtifactListResponse.make({
    artifacts: [...(yield* (yield* ArtifactStore).list(actor.person.id, threadId))],
  })
})

/** One Artifact as the Actor may read it, at the version asked for or the newest. */
const detail = Effect.fn('Artifacts.detail')(function* (
  actor: Actor,
  request: typeof GetArtifactRequest.Type,
) {
  return yield* (yield* ArtifactStore).get(actor.person.id, request)
})

/** The shelf as the wire carries it. */
const shelf = Effect.fn('Artifacts.shelf')(function* (actor: Actor) {
  return ArtifactShelfResponse.make({
    artifacts: [...(yield* (yield* ArtifactStore).shelf(actor))],
  })
})

/** Transport identity is injected here; storage owns access, versioning and publication. */
export const artifactHandlers = {
  InspectArtifactFile: Effect.fn('Rpc.InspectArtifactFile')(function* (
    request: InspectArtifactFileRequest,
  ) {
    const auth = yield* requireVivid()
    return yield* inspectArtifactFile(auth.person.id, auth.threadId, request)
  }),
  PublishArtifactFile: Effect.fn('Rpc.PublishArtifactFile')(function* (
    request: PublishArtifactFileRequest,
  ) {
    const auth = yield* requireVivid()
    return yield* publishArtifactFile(auth.person.id, auth.threadId, request)
  }),
  ListArtifacts: Effect.fn('Rpc.ListArtifacts')(function* ({
    threadId,
  }: {
    readonly threadId: ThreadId
  }) {
    return yield* load(yield* requireActor(), threadId)
  }),
  WatchArtifacts: ({ threadId }: { readonly threadId: ThreadId }) =>
    live('WatchArtifacts', [], (actor) => load(actor, threadId), [Topic.thread(threadId)]),
  /**
   * One Artifact, read again whenever its Thread moves: a new version adds to its history and a
   * removal ends the stream with `NotFound`. The Thread is found first only to name its topic;
   * access is the store's, on every read, exactly as `GetArtifact` decides it.
   */
  WatchArtifact: (request: typeof GetArtifactRequest.Type) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { threadId } = yield* find(request.id)
        return live('WatchArtifact', [], (actor) => detail(actor, request), [
          Topic.thread(threadId),
        ])
      }),
    ),
  /** The Person's shelf of Artifacts, read again when one moves in a Thread they can reach. */
  WatchArtifactShelf: () => live('WatchArtifactShelf', ['artifacts'], shelf),
  GetArtifact: Effect.fn('Rpc.GetArtifact')(function* (request: typeof GetArtifactRequest.Type) {
    return yield* (yield* ArtifactStore).get((yield* requireActor()).person.id, request)
  }),
  ReviseArtifact: Effect.fn('Rpc.ReviseArtifact')(function* (
    request: typeof ReviseArtifactRequest.Type,
  ) {
    return ArtifactResponse.make({
      artifact: yield* (yield* ArtifactStore).revise((yield* requirePerson()).person, request),
    })
  }),
  RemoveArtifact: Effect.fn('Rpc.RemoveArtifact')(function* ({ id }: { readonly id: ArtifactId }) {
    return yield* (yield* ArtifactStore).remove((yield* requirePerson()).person.id, id)
  }),
  WriteDocument: Effect.fn('Rpc.WriteDocument')(function* (request: WriteDocumentRequest) {
    const auth = yield* requireVivid()
    return yield* (yield* ArtifactStore).write(auth.person.id, auth.threadId, request)
  }),
  ReadDocument: Effect.fn('Rpc.ReadDocument')(function* (request: typeof ReadDocumentRequest.Type) {
    const auth = yield* requireRun()
    return yield* (yield* ArtifactStore).read(auth.person.id, auth.threadId, request)
  }),
}

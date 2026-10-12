import {
  ArtifactListResponse,
  ArtifactResponse,
  type ArtifactId,
  type GetArtifactRequest,
  type ReadDocumentRequest,
  type ReviseArtifactRequest,
  type ThreadId,
  type WriteDocumentRequest,
} from '@vivid/contracts'
import { Effect } from 'effect'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { ArtifactStore } from './store.ts'

/** Listing and watching share the same Thread access check, repeated after each invalidation. */
const load = Effect.fn('Artifacts.load')(function* (actor: Actor, threadId: ThreadId) {
  return ArtifactListResponse.make({
    artifacts: [...(yield* (yield* ArtifactStore).list(actor.person.id, threadId))],
  })
})

/** Transport identity is injected here; storage owns access, versioning and publication. */
export const artifactHandlers = {
  ListArtifacts: Effect.fn('Rpc.ListArtifacts')(function* ({
    threadId,
  }: {
    readonly threadId: ThreadId
  }) {
    return yield* load(yield* requireActor(), threadId)
  }),
  WatchArtifacts: ({ threadId }: { readonly threadId: ThreadId }) =>
    live('WatchArtifacts', (actor) => load(actor, threadId), [Topic.thread(threadId)]),
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
    const auth = yield* requireVivid()
    return yield* (yield* ArtifactStore).read(auth.person.id, auth.threadId, request)
  }),
}

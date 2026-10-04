import { type PersonId, type ThreadId } from '@vivid/contracts'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { Actor } from '../auth/access.ts'
import { authenticateVivid } from '../auth/session.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'

export interface CodeBoundary {
  readonly person: PersonId
  readonly thread: ThreadId
}

export class CodeAuthorityRevoked extends Schema.TaggedError<CodeAuthorityRevoked>()(
  'CodeAuthorityRevoked',
  {},
  { title: 'Program authority revoked' },
) {}

export interface CodeAuthorityService {
  readonly refresh: (
    boundary: CodeBoundary,
  ) => Effect.Effect<Actor, CodeAuthorityRevoked | DatabaseInfrastructureError>
}

/** Identity is bound at the RPC boundary. Every queued call reloads Thread visibility and Membership. */
export class CodeAuthority extends Context.Service<CodeAuthority, CodeAuthorityService>()(
  'vivid/CodeAuthority',
) {}

export const codeAuthorityLayer = Layer.effect(
  CodeAuthority,
  Effect.gen(function* () {
    // Capture only database authority: a new scoped lookup must fail against refresh's service
    // contract instead of silently inheriting Layer.effect's construction Scope.
    const database = yield* Database
    return CodeAuthority.of({
      refresh: Effect.fn('Code.refreshAuthority')((boundary) =>
        authenticateVivid({ thread: boundary.thread, actor: boundary.person }).pipe(
          Effect.provideService(Database, database),
          Effect.map((auth): Actor => ({
            person: auth.person,
            workspace: auth.workspace,
            by: 'vivid',
            threadId: Option.some(auth.threadId),
          })),
          Effect.catchTags({
            NotFound: () => Effect.fail(new CodeAuthorityRevoked({})),
            Forbidden: () => Effect.fail(new CodeAuthorityRevoked({})),
          }),
        ),
      ),
    })
  }),
)

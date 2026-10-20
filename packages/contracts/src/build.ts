import { Schema } from 'effect'

/**
 * Which build of Vivid is running, for a Person who was told a change is merged or deployed and
 * wants to see whether what is in front of them has it (5 October 2026: "build information... in
 * the app").
 *
 * A build is named by the commit it was built from. Railway names it to the build that a push to
 * `main` starts (`RAILWAY_GIT_COMMIT_SHA`, which `apps/server/Dockerfile` hands on as
 * `VIVID_COMMIT`), so the name comes from the build and never from a value written into the code.
 */

/**
 * A git commit: 7 to 40 lowercase hexadecimal digits, the abbreviated and the full form of a
 * SHA-1. Anything else given as a commit is not one, and is never shown or sent as one.
 */
export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/u)).pipe(
  Schema.brand('Commit'),
)
export type Commit = typeof Commit.Type

/** A commit as it is said: its first seven digits, as git and GitHub abbreviate it. */
export const shortCommit = (commit: Commit): string => commit.slice(0, 7)

/**
 * The build of the server that is answering. A web page and the server that sent it are one
 * build until the next deploy, but a page left open keeps running the old one, and the desktop
 * app carries its own copy of the page, so the two are said apart.
 *
 * `Unnamed` is a server whose host did not name a commit: one started from a working tree, or a
 * deploy that was not built from a push.
 */
export const ServerBuild = Schema.TaggedUnion({
  Named: { commit: Commit },
  Unnamed: {},
})
export type ServerBuild = typeof ServerBuild.Type

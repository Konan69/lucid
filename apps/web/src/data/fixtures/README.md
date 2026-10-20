# Better Auth session sample

`sessions.json` was produced offline by the installed Better Auth 1.7.5
`dist/db/schema.mjs` `parseSessionOutput`, then JSON serialization, using an inert session.
All identifiers and the credential are synthetic. No person's session was captured.
The installed `@better-auth/core` `dist/db/schema/session.mjs` declares a string token
and a nullable user agent. Better Auth's `dist/api/routes/session.mjs` `listSessions`
returns an array through `ctx.json` and `parseSessionOutput`. Dates become ISO strings.

`account.test.ts` passes this JSON to the real `signedInDevices` reader, so the private
consumer schema must decode it and wrap the credential. No schema is copied into the test.

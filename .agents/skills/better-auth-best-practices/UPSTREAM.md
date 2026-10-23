# Upstream provenance

- Source: `better-auth/skills`
- Path: `better-auth/best-practices/SKILL.md`
- Base: `17dfe3a1da1c3982de723098ba1015d67f35694c` (content-derived)
- Merged commit: `20c9e88a5c007461a703f1c213572b073196113e`
- Merged at: `2026-09-19`

## Merge notes

Kept the owner/Vivid schema authority, `AUTH_SECRET` and `PUBLIC_URL`, and no-push migration rule. Added upstream version-aware documentation lookup and the renamed `auth` CLI. Vivid targets Better Auth 1.7.5 through `@alchemy.run/better-auth` beta.79. Executable examples are pnpm-only.

Owner text won where upstream recommended generic generated schemas or `drizzle-kit push`: Vivid edits auth tables in `apps/server/src/auth/tables.ts`, which `apps/server/src/database/schema.ts` re-exports for `pnpm --filter @vivid/server db:generate`.

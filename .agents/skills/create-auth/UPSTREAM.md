# Upstream provenance

- Source: `better-auth/skills`
- Path: `better-auth/create-auth/SKILL.md`
- Base: `17dfe3a1da1c3982de723098ba1015d67f35694c` (content-derived)
- Merged commit: `20c9e88a5c007461a703f1c213572b073196113e`
- Merged at: `2026-09-19`

## Merge notes

Kept the owner's pnpm commands and merged the upstream rename from `@better-auth/cli` to `auth`. Added the Vivid schema and migration path. Owner/Vivid policy won over upstream development-push guidance: Vivid never pushes a shared database and keeps auth tables in `apps/server/src/schema.ts`.

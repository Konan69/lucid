# Local provenance

- Source: Vivid repository-local adaptation of the VCOS owner doctrine
- Source type: `local`
- Owner reference: `/home/kixey/work/VCOS/.agents/skills/runtime-integration-testing/SKILL.md`
- External upstream: none discoverable
- Merged commit: `local-2026-09-19`
- Merged at: `2026-09-19`

## Adaptation notes

The owner skill's rule—test a real runtime seam and do not use mocks to prove runtime behavior—is preserved. Cloudflare/workerd/Durable Object specifics were replaced with Vivid's PostgreSQL 18, Effect HttpApi, Better Auth, Hono/Flue, connector, and Alchemy boundaries.

The skill records current limitations rather than inventing APIs: manifests target Effect rc.116 while the lock resolves rc.112; `@effect/vitest` is not a direct dependency; `vitest-evals` is not installed; server/runtime app factories and database lifecycle harnesses still require extraction. Installed rc.112 `NodeHttpServer.layerTest` / `HttpRouter.toWebHandler` and Flue 2.0.3's pi-ai faux-provider seam were verified and documented; target-version APIs remain deferred. No owner conflict exists because this is a deliberate Vivid-local adaptation, not a verbatim vendor copy.

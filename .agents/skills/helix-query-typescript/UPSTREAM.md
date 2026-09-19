# Upstream provenance

- Source: `HelixDB/skills`
- Path: `skills/helix-query-typescript`
- Base: unknown owner v3-era copy
- Merged commit: `199e5d03a18181fef535826e78de9922bd6fd9f1`
- Merged at: `2026-09-19`

## Merge notes

Replaced upstream-owned files with the current v3.0.4 published-package, structured-error, and retry guidance. Kept Vivid's pnpm-only install command. Preserved the owner's bundled-runtime and vector-index observations, but scoped them explicitly to legacy CLI v3.1.1 and marked them unverified against the current CLI. Current upstream wins for default behavior. Shared error handling points to the vendored local file.

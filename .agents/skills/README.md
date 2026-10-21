# Vendored skills

All hashes in `skills-lock.json` exclude each skill's `UPSTREAM.md`. External skills are merged with owner/Vivid adaptations; owner-only skills keep their existing files byte-identical.

| Skill | Upstream | Merged commit | Owner edits kept | What changed |
| --- | --- | --- | --- | --- |
| better-auth-best-practices | better-auth/skills | `20c9e88a` | Vivid schema/env/no-push policy | Version-aware docs; `auth` CLI; Better Auth 1.7.5/beta.79 |
| better-auth-security-best-practices | better-auth/skills | `20c9e88a` | none | Provenance; content already current |
| coding-standards | dmmulroy/skills | `86033808` | `Schema.TaggedError` adaptation | Corrected provenance; Effect wording matches the installed rc.116 |
| create-auth | better-auth/skills | `20c9e88a` | pnpm and Vivid migrations | `auth` CLI rename; removed shared-DB push advice |
| diagnose | VCOS owner | `7f38dca4` | all files byte-identical | Provenance only |
| drizzle | drizzle-kit RC.5 bundle | `ab785fcd` | bundle content | Provenance; pnpm-only installed binary invocation |
| drizzle-generate | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance only |
| drizzle-hints | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance only |
| drizzle-migrations | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance only |
| drizzle-output-modes | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance only |
| drizzle-pull | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance only |
| drizzle-push | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance only; Vivid no-push policy recorded |
| drizzle-responses-and-errors | drizzle-kit RC.5 bundle | `ab785fcd` | none | Provenance plus package-manager-neutral wording |
| effect | kitlangton/skills | `22c35cb7` | Vivid references and owner wording | Scheduling and pagination corrections; truthful RC state |
| effect-service-design | dmmulroy/skills | `86033808` | owner `SKILL.md` | Added upstream audit reference, OpenAI metadata, and complete provenance |
| email-and-password-best-practices | better-auth/skills | `20c9e88a` | pnpm/Vivid migration policy | `auth` CLI rename |
| helix-cli | HelixDB/skills | `199e5d03` | legacy v3.1.1 live facts | Current WorkOS/broker CLI; legacy note scoped/unverified |
| helix-memory-system | HelixDB/skills | `199e5d03` | empty-result invariant | Current conflict/replay guidance and local error link |
| helix-query-json-dynamic | HelixDB/skills | `199e5d03` | none | Current v3.2.2 plus vendored shared error handling |
| helix-query-optimize | HelixDB/skills | `199e5d03` | none | Current v3.2.2 planner guidance |
| helix-query-typescript | HelixDB/skills | `199e5d03` | pnpm; legacy SDK/vector gotchas | Current v3.0.4; legacy notes scoped/unverified |
| improve-codebase-architecture | VCOS owner | `7f38dca4` | all files byte-identical | Provenance only |
| infra | Vivid local | `8580c04b` | all local content | Provenance only |
| organization-best-practices | better-auth/skills | `20c9e88a` | pnpm/Vivid migration policy | `auth` CLI rename |
| product-description | VCOS owner | `11b030f9` | all files byte-identical | Provenance only |
| prototype | VCOS owner | `7f38dca4` | all files byte-identical | Provenance only |
| react-useeffect | softaworks/agent-toolkit | `3027f20f` | none | Provenance; content already current |
| runtime-integration-testing | Vivid local/VCOS doctrine | `local-2026-09-19` | real-runtime doctrine | New per-test PostgreSQL/HTTP/Auth/Flue/connectors/Alchemy guidance with verified rc.116/Flue seams |
| tdd | VCOS owner | `7f38dca4` | all files byte-identical | Provenance only |
| to-issues | VCOS owner | `7f38dca4` | all files byte-identical | Provenance only |
| to-prd | VCOS owner | `7f38dca4` | all files byte-identical | Provenance only |
| turborepo | vercel/turborepo | `bcc853c2` | pnpm-only policy | Complete 2.11.2 refresh |
| vitest-evals | getsentry/vitest-evals | `8cff207d` | two pnpm install edits | Complete current refresh |
| app-designer | supplied by the owner as `app-designer.zip` | `local-2026-10-13` | pnpm in place of the other package manager | New: direction by three rendered explorations, slop scan, critic rubric |
| image-gen | owner's own skill | `local-2026-10-13` | reads the model output one level deeper, as the provider now returns it | New: image assets through Cloudflare unified AI |
| verify-vivid | Vivid owner | `local-2026-10-21` | ownership and cleanup from `5b9deee3` | Current-main Flue rehearsal, real SQL, web evidence and mandatory feature verification |

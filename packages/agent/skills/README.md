# Skills

Vivid ships 22 native Agent Skills folders here. Each `SKILL.md` owns its runtime name,
description and unchanged procedure body. YAML literal scalars preserve text through formatting;
`metadata.provenance` retains the former TypeScript JSDoc, including source/adaptation details.

`src/manifest.ts` is the shared, Schema-decoded manifest for display names, `about`, starter
suggestions, tool prerequisites and required Integrations. The server and runtime import this
module directly; no dependency or workspace configuration change is needed. The server derives
BuiltIn `ListSkills` / `ReadSkill` records from the manifest and Markdown, retaining existing
`builtin:<normalized-display-name>` IDs and release timestamps. Suggestions use the manifest.

The runtime statically imports every folder and mounts it through Flue's `useSkill`. Flue owns
Available Skills and `activate_skill`; built-ins are absent from the custom saved inventory.
Its mount map must cover every manifest runtime name at typecheck. Adding a skill means adding
one folder, one manifest entry and one static import/mount-map entry; catalogue tests check
registered tools and prerequisites, unchanged migration bodies, identities and scoped overrides.

Saved Person and Company skills retain the authorized `read_skill` RPC path in phase 1. Flue
persists native catalogue snapshots/signals in shared Thread history, so mounting private names
as inline skills would expose them to other People. Only built-in IDs present in the prepared,
frozen response summaries mount: the server already removes a built-in when an authorized saved
procedure has its display name. Missing summaries mount none rather than bypassing precedence.
Saved names never become native catalogue entries. Previously disclosed instructions cannot be
retracted from conversation history; manager installation/provenance and policy remain phase 2.

# Skills

`@vivid/skills` ships 22 native Agent Skills folders. Each `SKILL.md` owns its runtime name,
description and procedure body. YAML literal scalars preserve text through formatting;
`metadata.provenance` retains the former TypeScript JSDoc, including source/adaptation details.

The manifest export owns display names, `about`, starter suggestions, tool prerequisites and
required Integrations. It is authored, typed data, not unknown ingress. The server derives BuiltIn
`ListSkills` / `ReadSkill` records from the manifest and the Markdown loader, retaining existing
`builtin:<normalized-display-name>` IDs and release timestamps. Suggestions use the manifest.
The Markdown loader reuses Flue 2.2.2's validated frontmatter parser through its `/internal`
export; the root API has no parser export. File and validation failures have separate tagged errors.

The native export statically imports every folder. Every Vivid response mounts all 22 through
Flue's `useSkill`, in manifest order, regardless of saved-procedure availability. Flue owns
Available Skills and `activate_skill`; built-ins are absent from the custom saved inventory.
Adding a skill requires a folder, a manifest entry and a static import/map entry. Tests compare
the folder list, manifest and imported names, then render Vivid through Flue's public `start`
with in-memory SQLite and a local model provider to observe the actual catalogue and activation.

Skills belong to Vivid. Vivid saves verified reusable procedures when they will help future work;
a Person never needs to see, name, edit or manage them. Built-in runtime and display names are
reserved: `save_skill` refuses them, and `read_skill` redirects built-in names to native activation.
Legacy saved collisions receive distinct saved runtime labels and remain readable without
replacing a built-in. An unavailable summary catalogue produces an explicit tagged model context.

Saved Person and Company procedures retain the authorized `read_skill` RPC path. Flue persists
native catalogue snapshots/signals in shared Thread history, so mounting private saved names
would expose them to other People. Saved names never enter that catalogue. Previously disclosed
instructions cannot be retracted from conversation history. Installation and imported provenance
persistence remain outside this phase.

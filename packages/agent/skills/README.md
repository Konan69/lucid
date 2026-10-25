# Skills

`@vivid/skills` ships built-in procedure folders. Each `SKILL.md` owns its runtime name,
description and body. The manifest owns display names, product summaries, starter suggestions,
tool prerequisites and required Integrations. The server derives its built-in catalogue through
`readMarkdown`, preserving skill identities and release timestamps.

The Markdown catalogue reads release assets synchronously at server startup. Its parser accepts
the shipped one-line scalars and literal blocks and refuses unsupported YAML. File failures and
invalid procedures remain separate tagged errors. Provenance metadata never enters the catalogue.

Pi Durable's runtime reads the exported `@vivid/skills/<name>/SKILL.md` files itself and owns
catalogue rendering and `activate_skill`. The unused native export and its build plugin are gone.
Adding a built-in requires its folder and manifest entry. Tests read every shipped asset.

Saved Person and Company procedures retain the authorized `read_skill` RPC path. Private saved
names never enter the shared built-in catalogue. Built-in names remain reserved, and saved
collisions cannot replace a built-in.

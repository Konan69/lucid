# Input requests

A durable question a Run cannot safely answer alone. It survives the Run that asked it, and
answering it resumes the work.

- `tables.ts`: one row per Input request, with the Person asked, the options offered, and how it
  ended (`waiting`, `answered` or `withdrawn`).
- `store.ts`: asking, answering and withdrawing. The Person asked and the Person answering must
  both be real identities in persistence.
- `handlers.ts`: the RPC surface every client uses to list and answer them.

Vivid raises one with its `ask` tool; the Thread shows it as a card. Defined by
`docs/03-surface.md`.

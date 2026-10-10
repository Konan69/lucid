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

An ordinary message admitted from the Person asked moves the Thread on: after Run reservation
and runtime acceptance, `withdrawWaiting` conditionally closes all their waiting questions in
that Thread. Answers, server signals, channel text, refused messages and replayed sends do not
withdraw questions. The conditional update leaves answered and withdrawn rows unchanged.
Admission publishes the Person and Thread topics so open inboxes and Thread cards refresh.

The runtime receives the message exactly as the Person wrote it. Nothing is added to their
words: Vivid reads its own unanswered question followed by their message, and the question's
record says it was withdrawn.

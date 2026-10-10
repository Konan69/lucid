# Input requests

A durable set of one to four questions a Run cannot safely answer alone. Vivid asks everything
needed in one `ask_person` call; the request survives its Run and resumes work only after every
question has an answer.

- `tables.ts`: one row per request, with encoded non-empty `questions` and ordered `answers` in
  JSONB. Answers are null while waiting or withdrawn. The Person asked and the Person answering
  are real identities; `waiting`, `answered`, and `withdrawn` are conditional persistent states.
- `validation.ts`: checks the answer count and every question/answer pair before any write.
  Chosen labels must be offered, unique, and singular for `One`; `Several` allows multiple
  offered labels. Written answers require own-answer permission and nonblank words. Refusals
  have distinct typed tags on the store and RPC seams.
- `store.ts`: asking, answering, withdrawing, and durable delivery. Answering makes one conditional
  update from `waiting`, storing all answers and the owed signal together. Replayed delivery
  uses that stored text: a single answer alone, or one line per question, its words then the answer.
  Chosen labels join with ", "; written words retain their original spacing.
- `handlers.ts`: the authenticated RPC surface every client uses to ask and answer requests.

The notification previews the first question and says how many more there are in words. The
Thread card carries all question text; product semantics are defined by `docs/03-surface.md`.

The product migration converts each existing row into one question with `selection: 'One'`,
preserving its question, options, and own-answer permission. An old answer exactly matching an
option label becomes `Chosen` with one label; every other nonnull answer becomes `Written`.
Waiting and withdrawn rows retain null answers. Identities, states, timestamps, indexes, and
already-owed delivery signals are unchanged. Old columns are removed after the data conversion;
there is no old-shape read branch.

An ordinary message admitted from the Person asked moves the Thread on: after Run reservation
and runtime acceptance, `withdrawWaiting` conditionally closes all their waiting requests in that
Thread. Answers, server signals, channel text, refused messages and replayed sends do not
withdraw requests. The conditional update leaves answered and withdrawn rows unchanged.
Admission publishes the Person and Thread topics so open inboxes and Thread cards refresh.

The runtime receives the message exactly as the Person wrote it. Nothing is added to their
words: Vivid reads its own unanswered questions followed by their message, and the request's
record says it was withdrawn.

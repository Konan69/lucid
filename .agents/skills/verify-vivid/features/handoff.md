# Hand over a step

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

Vivid reaches a page on its Computer that only the Person can finish, hands them that step with `request_handoff`, and carries on in the same Thread when they press Continue. A form step lists the fields found on the page; the Person types the values into secure fields, the server types them into the page privately and keeps one result per field. A screen step has no fields; the Person takes the Computer's screen. While the step is open the Computer is held: Vivid's own steps are refused and a Hand back from the Computer panel does not end it.

## How to get to it (user POV)

Ask Vivid to sign in to a test page served on the proof stack (never a real site, never a real password). It opens the page on its Computer and the Thread shows the step over the composer with an Email and a Password field. Type a sentinel email and password, press Fill, finish on the screen (press the page's own Sign in button in the Computer panel), then press Continue. Vivid's next turn names each field's result and never a value. A second journey asks Vivid to hand over a CAPTCHA on the same page: press Take the screen, then Continue.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature handoff` after Launch and Doctor, then `verify browser handoff`. Both currently return blocked before exercising the journey and write only `handoff/verdict.json` and `browser/handoff/verdict.json`. When a disposable Computer exists, the recipe must check: one `PrepareHandoff` Form with both fields `Waiting`; `FillHandoff` answering `Filled` for each; the test page receiving exactly the sentinels; `CompleteHandoff` once giving one successor Decision Run; that Run's model-visible history containing `Email: filled.` and neither sentinel; neither sentinel in `vivid_handoffs`, the server log or the evidence; a second Complete owing nothing more; and the Screen journey reaching `Completed` the same way.

## Gotchas

Blocked here: no proof-owned Computer (the Boat plan is at its machine limit, and the only Vivid Computer is production's, which refuses other servers). The server side is proved by the database-backed suite `apps/server/src/inputs/handoff.test.ts` (values reach only the Computer seam; no row, signal, view or log line holds them; one continuation; only the Person asked can fill) and the hold case in `apps/server/src/computers/store.test.ts`. The Boat field operations (`apps/server/src/computers/boat/fields.ts`), the phone's Open the screen and embedded or shadow-root fields are unproved until this recipe runs.

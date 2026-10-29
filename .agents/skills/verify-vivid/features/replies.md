# Suggested replies

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

Vivid may end a reply with one to three short replies the Person can tap instead of typing (`suggest_replies` in `packages/agent/runtime/src/tools/follow.ts`). Pi stores the call in the conversation; the clients read it with `offeredReplies` in `packages/client/state/src/offered.ts` and draw it only under the newest reply while Vivid is not working. A tap sends the words as the Person's next message.

## How to get to it (user POV)

Ask something whose reply invites a short answer, such as whether to bring a jacket somewhere. The pills appear under the reply; tap one.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature replies` after Launch and Doctor. It asserts one to three stored replies of at most 40 characters on the newest assistant message (`replies/offered.json`). Then run `verify browser replies`. It checks the drawn pills equal the stored offer before and after reload, taps the first, and checks the second Person message carries exactly those words and the pills now show the newest reply's own offer (`browser/replies/after-tap.json`).

## Gotchas

The model chooses whether to offer; a reply with no obvious next step offers none, and the recipe's prompt is written so one exists. A draft is drawn as a letter whose own Send button is the next step, so it offers no pills; the recipe avoids drafts. The prompt is in a Person's words and never names the tool. The phone draws the same offer through `apps/mobile/src/screen/chat/Replies.tsx`; this recipe does not prove it.

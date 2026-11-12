# Unsent words

Model requirement: a real model. Send again must be answered by a completed Run.

## Sub-features

Words the server never confirmed stay in their Thread as **Not sent.** with a **Send again** button. Each Thread's unsent words are kept in the browser's storage (`vivid-unsent`) under the Person and workspace that wrote them, restored when the page loads, and sent again under their original delivery key (`packages/client/state/src/sending.ts` `Unsent`, `Kept`, `Restore`; `apps/web/src/data/sending.ts`). The phone keeps them in its files the same way (`apps/mobile/src/data/sending.ts`).

## How to get to it (user POV)

Lose the connection, type a message and press Send. The Thread shows Not sent. Reload when back online: the words and the line are still there. Press Send again: Vivid answers once.

## Driving it with verify-vivid

After Launch and Doctor, run `verify browser unsent <run>`. The browser goes offline, sends through the composer, and waits for Not sent. and the words in browser storage. Public history must not hold the words. Back online, it reloads, finds the restored words and line, presses Send again, and requires one completed Run whose history holds the words once. The line and the stored entry must be gone, including after a final reload. `verify feature unsent` reports blocked: the words live only in the client.

## Gotchas

Offline is Chrome's network emulation, so the client sees a real transport failure (`Unconfirmed`). Refused and `Unstarted` sends, a workspace switch, a second Person on the same browser and the phone remain unproved.

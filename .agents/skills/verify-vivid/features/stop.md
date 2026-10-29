# Stop work

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The captured active Run becomes Stopped. Streaming ends, Stop disappears and reload retains the interrupted reply without restarting it.

## How to get to it (user POV)

Send a request that is visibly still working. With an empty draft, press Stop in the composer. An open question has a separate Stop control, including while typing or uploading a picture.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature stop <run>` after Launch and Doctor, then run `verify browser stop <run>`.

Both recipes ask the real model for a long community-garden guide directly in the reply. WatchConversation must publish nonempty streaming assistant text while working. GetThread must identify exactly one Working Run whose submission owns those words. HTTP calls StopThread. Browser sends through the composer and clicks its actual Stop button with an empty draft.

WatchThread must publish that same Run as Stopped. A fresh conversation subscription must show its aborted settlement, no streaming parts and the captured partial reply retained. Reopening must preserve message ids, parts and settlement, with no working or queued response and no new Run. Browser also requires visible reply bubbles and no Stop control before and after reload, and compares their text.

Inspect `stop/` and `browser/stop/`. Each retains active-stream frames, active Run and partial, settlement, history, reloaded history and Thread, SQL and verdict. Browser also retains commands, screenshots, exact rendered reply counts and browser-reloaded history and Thread. Existing browser and Launch cleanup own all processes and disposable stores.

## Gotchas

The request length does not establish activity. A model that completes before the capture or Stop, produces no streaming words or only creates a document fails the journey. Rehearsal is blocked. No timing seam, held handler, fixed model answer or sleep is installed. An open ask_person question is insufficient because that tool returns immediately and its Run can complete.

This recipe proves ordinary reply interruption and client reload. It does not prove a separate Stop beside an open question, tool cancellation, native clients or process restart.

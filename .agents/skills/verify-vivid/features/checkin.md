# Check-ins

Model requirement: a real model, provider keys and the disposable Executor installed by Launch.

Run Launch, Doctor, `verify feature checkin`, `verify browser checkin`, then Cleanup at the committed head. The HTTP recipe is [checkin.mjs](../scripts/checkin.mjs). Browser rendering of check-in state belongs to the following UI unit and has no recipe here. A missing browser recipe is blocked, not verified.

The HTTP journey asks Vivid to track an owed report and "check on this tomorrow at 9" in Africa/Lagos. It requires a Checkin Watch whose arming is Confirmed, with the actual timer operationKey and the requested nextAt. The saved `use_tool` result must carry that receipt. Subscription success or a sentence from the model is insufficient.

It changes the request to the timer's shortest positive delay. A WatchWork subscription observes the new operation's Confirmed state. The real timer fires without the recipe invoking its emitting mutation. WatchFeed and WatchThread then prove one check-in-origin Run, a real open-work read and the requested Feed post. No sleeps or polling decide success.

Evidence stays in `checkin/`. `clock-time-receipt.json` records the tomorrow-at-nine arm. `proof.json` records both scheduling receipts, the Watch, the firing Run and its Feed item. `firing-history.json` retains the actual background tool calls.

Database-backed receiver coverage separately proves Awaiting before a matching receipt, invalid receipts retaining Awaiting, stale operation keys being ignored, and a resolved owed source completing its check-in at firing.

Active Projects are candidates in list_open_work. Project-focused checks read the current objective, next step and progress on firing, and complete with the persisted Project proof after completion. The goal-to-chosen-check-to-progress-to-completion journey runs as part of `verify feature projectchecks`; see [projects](projects.md) and its `project-check-proof.json` evidence. Bootstrap for open records that predate check-ins is not needed while owed is undeployed. There is no bootstrap admission or CheckinPlanning origin.

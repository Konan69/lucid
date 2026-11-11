# One completion notification per reply

Model requirement: real. No external notification provider or fixture is needed. This checks durable completion notifications and the web notification list, not operating-system push delivery.

After Launch and worthy Doctor, run `verify feature completion <run>` and `verify browser completion <run>`, then Cleanup on the unchanged head. Source is `.agents/skills/verify-vivid/scripts/completion.mjs`. Evidence is under `completion/` and `browser/completion/`, with separate `joined/` and `single/` checkpoints.

Keep the Person off the target Thread. Send two ordinary messages back to back through the public gateway. Wait on WatchThread for both Runs to finish. Require their actual response ids to agree before claiming the joined-message case. If they do not join, record blocked for this case. Do not hold a model or replace transport to force the result.

WatchNotifications supplies the completion-publication signal. Require exactly one finished notice for that Thread in the disposable database and the public client list, with the same id. The browser remains on another Thread, opens Notifications after completion and requires one row for the target title. Retain the screenshot. The recipe first runs one ordinary message in a fresh Thread and requires exactly one completion notice, so a failed joined setup does not hide the ordinary regression.

`settlement.json` retains response identities, `history.json` the real reply, `notifications.json` the client list, `database.json` the read-only rows, and `proof.json` the successful checkpoint. No presence is fabricated. No direct writes touch the notification database. Phone and desktop native notification lists need separate client runs.

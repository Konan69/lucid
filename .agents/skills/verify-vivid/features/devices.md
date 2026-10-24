# Device permission requests

Model requirement: none for this journey. Launch still requires provider keys and a real runtime model. These recipes make no model calls and prove no model behaviour.

## Sub-features

A desktop installation enrols through public `EnrolDevice`. Its access stays `Pending` until the Person explicitly chooses Allow or Deny. Another allowed device holding `WatchDeviceRequests` must not hide that request.

The request appears on Home, a Thread, Feed, and Settings after reload. A separate request section remains actionable alongside a structured Thread question. Allow switches the allowed computer. Deny resolves the request. Settings can stop allowing a computer.

## How to get to it

Sign into the desktop app on a new installation. Open Home, a Thread, Feed, or Settings > Devices in the web app. Decide through the visible device controls.

## Drive with verify-vivid

After Launch and Doctor on the unchanged combined commit, run these commands with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature devices flue-<id>
.agents/skills/verify-vivid/verify browser devices flue-<id>
.agents/skills/verify-vivid/verify cleanup flue-<id>
```

The HTTP recipe enrols disposable installations through public RPC. It checks repeated enrolment, Pending while a separate allowed computer is Connected, Allow, revoke, Deny, and denied re-enrolment. `other-connected.json` records actual public-stream presence. `device-stream-cleanup.json` and `other-disconnected.json` record closure of the owned native stream.

The browser recipe reuses the skill's private browser session, authentication, process receipts, screenshots, and cleanup. It checks requests and reloads on Home, Thread, Feed, and Settings. It chooses Deny in the Thread, Allow and Stop allowing in Settings, and Allow on Feed. Public `WatchDevices` receipts confirm each decision.

For Thread coexistence, the recipe calls the real `AskInput` RPC with the disposable runtime's authority and the synthetic account's Thread. It writes no database fixture and supplies no model response. `coexisting-question.json` records that public call. Screenshots and `question-remains.json` check that denying a device leaves the actual question Waiting. This proves control coexistence only. It does not prove question generation or answer delivery.

## Limits

The supervisor supports capture and cleanup, with no server-restart operation. `scope.json` records that limitation. The database-backed device suite must separately prove time beyond the former deadline and reconstruction with a fresh registry. Reload alone does not prove either fact.

Home has no public structured-question entry point. This journey checks its pending device section, while Thread checks coexistence with a question. Phone and desktop native controls require separate device runs. A Linux devbox cannot run an iOS simulator. The Android provisioner and idle [phone journey](phone.md) do not yet drive device permission cards.

Device permission cards on Feed do not establish general Feed delivery, Watch occurrences, reminders, or external Integration callbacks. The [Feed](feed.md) and [Watch](watch.md) recipes retain their blocked verdicts.

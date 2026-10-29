# Device permission requests

Model requirement: none for this journey. Launch still requires provider keys and a real runtime model. These recipes make no model calls and prove no model behaviour.

## Sub-features

A desktop installation enrols through public `EnrolDevice`. Its access stays `Pending` until the Person explicitly chooses Allow or Deny. Another allowed device holding `WatchDeviceRequests` must not hide that request.

Only the newest Pending computer asks; an older one (a reinstalled app leaves one) is answered in Settings. The request appears only on Feed and in Settings > Devices after reload, never inside a Thread on any surface or on the empty start screen. Allow switches the allowed computer. Deny resolves the request. Settings can stop allowing a computer.

## How to get to it

Sign into the desktop app on a new installation. Open Feed or Settings > Devices in the web app. Decide through the visible device controls.

## Drive with verify-vivid

After Launch and Doctor on the unchanged combined commit, run these commands with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature devices pi-<id>
.agents/skills/verify-vivid/verify browser devices pi-<id>
.agents/skills/verify-vivid/verify cleanup pi-<id>
```

The HTTP recipe enrols disposable installations through public RPC. It checks repeated enrolment, Pending while a separate allowed computer is Connected, Allow, revoke, Deny, and denied re-enrolment. `other-connected.json` records actual public-stream presence. `device-stream-cleanup.json` and `other-disconnected.json` record closure of the owned native stream.

The browser recipe reuses the skill's private browser session, authentication, process receipts, screenshots, and cleanup. It checks that a Thread carries no device request before or after reload while a device is Pending, and that Home carries no request. It checks requests and reloads on Feed and in Settings, and that an older Pending computer does not ask on Feed. It chooses Allow and Deny on Feed, and Allow and Stop allowing in Settings. Public `WatchDevices` receipts confirm each decision.

## Limits

The supervisor supports capture and cleanup, with no server-restart operation. `scope.json` records that limitation. The database-backed device suite must separately prove time beyond the former deadline and reconstruction with a fresh registry. Reload alone does not prove either fact.

Thread checks prove request absence in the web app. Phone and desktop native controls require separate device runs. A Linux devbox cannot run an iOS simulator. The Android provisioner and idle [phone journey](phone.md) do not yet drive device permission cards.

Device permission cards on Feed do not establish general Feed delivery, Watch occurrences, reminders, or external Integration callbacks. The [Feed](feed.md) and [Watch](watch.md) recipes retain their blocked verdicts.

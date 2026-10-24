# Device permission requests

Model requirement: none for these journeys. Launch still requires provider keys and a real runtime model. These recipes make no model calls and prove no model behaviour.

## Sub-features

A desktop installation enrols through public `EnrolDevice`. Its access stays `Pending` until the Person explicitly chooses Allow or Deny. Another allowed device holding `WatchDeviceRequests` must not hide that request.

The request appears only in Feed and Settings. Feed keeps it after reload and navigation. Home and Thread do not display it. An unrelated structured Thread question stays Waiting across navigation and device decisions. Allow switches the allowed computer. Deny resolves the request. Settings can stop allowing a computer.

## How to get to it

Sign into the desktop app on a new installation. Open Feed or Settings > Devices in the web app. On Android, open Feed from the menu, or Settings > Your computers. Decide through the visible device controls.

## Drive with verify-vivid

After Launch and Doctor on the unchanged combined commit, run these commands with the explicit run id.

```sh
.agents/skills/verify-vivid/verify feature devices flue-<id>
.agents/skills/verify-vivid/verify browser devices flue-<id>
.agents/skills/verify-vivid/verify phone devices flue-<id>
.agents/skills/verify-vivid/verify doctor flue-<id>
.agents/skills/verify-vivid/verify cleanup flue-<id>
```

The HTTP recipe enrols disposable installations through public RPC. It checks repeated enrolment, Pending while a separate allowed computer is Connected, Allow, revoke, Deny, and denied re-enrolment. `pending-published.json` records the exact Pending grant from `WatchDevices`. `other-connected.json` records actual public-stream presence. `device-stream-cleanup.json` and `other-disconnected.json` record closure of the owned native stream.

The browser recipe reuses the skill's private browser session, authentication, process receipts, screenshots, and cleanup. It checks Pending on Feed after reload and return from Home, Thread, and Settings. It asserts device requests are absent on Home and Thread, including after reload. It chooses Deny and Allow on Feed, and Allow and Stop allowing in Settings. Public `WatchDevices` receipts confirm each decision.

For Thread question preservation, the recipe calls the real `AskInput` RPC with the disposable runtime's authority and the synthetic account's Thread. It writes no database fixture and supplies no model response. `coexisting-question.json` records that public call. Screenshots and the `question-after-*.json` public receipts check that the same question remains Waiting after Feed Deny, Settings decisions, and Feed Allow. The Thread retains zero Runs. This proves question preservation only. It does not prove question generation or answer delivery.

## Drive Android devices

Read [Android setup](../references/android.md) and provision the selected devbox before Launch. `verify phone devices` uses the same lease, release APK, synthetic email sign-in, private agent-device session, `adb reverse`, and cleanup as the [idle Thread journey](phone.md). It creates only an idle Thread through public `CreateThread`. The nonempty Thread list prevents Home's first-arrival Run. It does not send a message or invoke a model.

The native journey holds a separately allowed computer's real request stream and publicly enrols a Pending installation. Actual agent-device presses open Feed, Home through New thread, the seeded Thread, Feed again, and Settings. Feed renders the exact computer question after app relaunch and return. Home and Chat snapshots must not contain that request while public `WatchDevices` still reports the original Pending grant and the other computer Connected.

Settings renders the pending computer and offers Deny. The journey presses its native Deny control, observes that exact device become Revoked through public `WatchDevices`, and returns to Feed without its pending card. Public `GetThread` confirms the selected Thread has zero Runs and the phone's synthetic Person is present. The presence assertion follows the actual `BePresent` subscription in `apps/mobile/src/screen/Chat.tsx` and `apps/mobile/src/data/live.ts`. Greeting text alone cannot satisfy it.

Evidence stays in `phone/`. `feed-pending`, `feed-reloaded`, and `feed-returned` retain full accessibility snapshots and screenshots of the pending card, heading, and native navigation control. Home, Chat, Settings, and the resolved Feed have separate captures. Numbered command receipts retain current interactive refs. `devices-scope.json` records limits. The APK identity, lease, cleanup, and Doctor receipts follow the [phone workflow](phone.md).

## Limits

The supervisor supports capture and cleanup, with no server-restart operation. `scope.json` records that limitation. The database-backed device suite must separately prove time beyond the former deadline and reconstruction with a fresh registry. Browser reload and Android app relaunch do not prove either fact.

Android screenshots provide layout evidence for review. A Linux devbox cannot prove iOS header clearance. That requires an iPhone or macOS runner. Desktop native controls require a separate native run.

Device permission cards on Feed do not establish general Feed delivery, Watch occurrences, reminders, or external Integration callbacks. The [Feed](feed.md) and [Watch](watch.md) recipes retain their own scope and limits.

# Notifications while away

Model requirement: the browser recipe needs a real model, which must choose to notify the Person when asked to. The HTTP recipe makes no model call.

## Behaviour and entry points

A Person turns notifications on for one browser in Settings > General, in the row "Notify me when something needs me". The browser asks for permission, subscribes its service worker against the server's public key (`GetPushKey`) and registers the subscription (`RegisterPushTarget`). Vivid also offers this once, in the press of the Person's first message, while they were never asked. The [machine](../../../../packages/client/state/src/notifying.ts) holds the lifecycle; the [browser adapter](../../../../apps/web/src/data/notifying.ts) and the [service worker](../../../../apps/web/src/worker/main.ts) are the web's side.

A launch reads the held subscription and registers it again: the server keeps one target per address and binds it to the current session. Turning off removes the target, then the subscription.

When Vivid notifies the Person (`notify_person`), puts a card on the Feed from a Background Thread, or asks a question or an Approval there, the server pushes a `PushPayload` to every target. Its `opens` says where pressing it goes, derived on the server from the notice's Thread: a Conversation opens itself, a Background Thread opens the Feed, and a Company invitation opens Notifications (the app's root on web, where the bell is). The worker shows it unless a Vivid window is in front, where the page says it itself. Pressing it focuses an open window and moves it there, or opens one there. The desktop app shows the same notice as the system's own while it runs, and the phone's tap handler routes on the same `opens`. A Feed post reaching the browser is driven by the [Watch](watch.md) browser recipe.

## Run the recipes

After Launch and Doctor on the unchanged commit, with a real model:

```sh
.agents/skills/verify-vivid/verify feature push flue-<id>
.agents/skills/verify-vivid/verify browser push flue-<id>
```

HTTP checks that `GetPushKey` answers an 87-character public key and that `ListPushTargets` decodes.

Browser grants notifications to the web origin through Chrome's `Browser.grantPermissions`, opens Settings, presses Turn on and waits for the row to offer Turn off. `ListPushTargets` must then hold one more `Browser` target. After a reload the same target id stands. A second tab is put in front, a real model Run in another Thread is asked to notify the Person, and the page must read a notification with that title from its service worker registration (`getNotifications`), opening that Thread. Turn off and a reload must leave no added target. Evidence is under `browser/push/`: `targets-*.json`, `endpoint.json` (the push service host only), `notifications.json`, `scope.json`, snapshots and screenshots.

## Blocked subcases

- The first-message offer needs a never-answered permission and a press inside a gesture; granting through CDP answers it first.
- Pressing a notification needs a drawn system notification; headless Chrome draws none to press.
- The phone registers an Expo push token, which needs the app's Expo project (`extra.eas.projectId`) and Firebase credentials in the build; a build without a project reads Unsupported in Settings. An iPhone build signed with a personal team (`VIVID_IOS_PERSONAL_TEAM=1`) has no push entitlement. The desktop app has no Web Push and shows system notifications only while it runs. Each needs its own device run.

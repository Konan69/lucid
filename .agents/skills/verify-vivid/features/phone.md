# Android product journeys

Model requirement: real for every journey except `thread`. The idle baseline makes no model call. Recipes are drafts until their recorded native run passes; source inspection and lifecycle tests do not verify product behavior.

## Drive the phone

Read [Android setup](../references/android.md). Select a devbox with `~/bin/devbox-pick`. Provision it from the PC with one command, even after a snapshot restore emptied both Android directories.

```sh
.agents/skills/verify-vivid/verify android provision cloudbox-konan3
```

In the separate proof checkout on that same host, run Launch and Doctor. Then run the phone journey with the explicit run id.

```sh
.agents/skills/verify-vivid/verify phone thread pi-<id>
.agents/skills/verify-vivid/verify doctor pi-<id>
.agents/skills/verify-vivid/verify cleanup pi-<id>
```

The recipe creates one idle Thread through public `CreateThread`, installs a release APK from the recorded commit, and clears only this disposable emulator's Vivid app data. `adb reverse` maps the APK's fixed emulator loopback address to this run's own single-origin web proxy. Email sign-in uses the run's synthetic Better Auth account. It uses neither Google nor a developer account.

`agent-device` opens Vivid, waits for the actual controls, and reads `snapshot -i` before each press or fill. The journey signs in, opens the menu, captures the Thread list, selects the exact seeded Thread button by its current snapshot ref, and waits for navigation to settle and the idle composer's `Message Vivid`. Public `GetThread` confirms the same id has zero Runs and the synthetic Person is present through the phone's held `BePresent` call. The phone deliberately keeps the Thread title in the menu; presence proves which Thread is on top after the drawer closes.

## Evidence

`phone/receipt.json` records host alias, observed hostname, serial, boot identity and captured process generations. `phone/apk.json` and `phone/verdict.json` record the APK SHA-256, native fingerprint, build mode and commit. Numbered command receipts retain snapshots and the exact selected refs. `phone/thread/threads.png` and `phone/thread/thread.png` show the signed-in list and idle Thread. Doctor includes the phone artifact identity. `phone/cleanup.json` and `phone/ps-cleanup.json` prove the owned processes stopped.

The command holds the devbox Android lock until its finally block closes the private agent-device session, stops its daemon, removes its reverse mapping, and stops the captured emulator and adb generations. `verify cleanup` repeats recovery after a killed command. SDK, AVD and APK caches remain rebuildable.

## Active journeys

After Launch and Doctor at a clean head, run `verify phone all <run>` for one APK installation and one private device session. Each named journey is also available as `verify phone <journey> <run>`. A phone command always stops its captured emulator in finally, so provision again before the next phone command. `all` continues after an individual journey fails and retains its crash logcat, snapshot and screenshot.

| Journey | Phone actions and required receipts |
| --- | --- |
| `thread` | Email sign-in, drawer selection, idle composer and public BePresent. |
| `send` | Composer Send, streamed marker, leave/reopen, kill/relaunch, contextual follow-up, matching durable history and WatchThread settlement. |
| `replies` | Send a natural question, tap a model-offered chip, compare its stored words with the next Person message. |
| `question` | Ask the web recipe's Cedar/Willow prompt, choose Cedar on the phone, assert Answered and a Decision Run using Cedar. |
| `approve` | Connect disposable Verify Pulse and add an Ask rule. Press Allow. Assert one provider event. |
| `deny` | A separate Thread and Ask rule. Press Don’t allow. Assert no provider event. |
| `stop` | Stop Vivid during real text, assert the same Run Stopped, retain partial after reopen, send and receive the next message. |
| `picture` | Push an opaque red PNG into Android media storage, use Attach files and Photos, select it in the API-35 picker, send and recognize red, reopen with retained file parts and screenshot. |
| `memory` | Tell a project preference, require write_memory, ask in a new Thread, require read_memory of the same address and a correct reply. |
| `settings-memory` | Seed through the phone, open Settings and What Vivid knows, open the row, Correct, edit What Vivid remembers and In full, Save correction, relaunch, Forget this, confirm Forget, relaunch and compare GetMemoryIndex. |
| `learning` | Mention a unique durable fact without a remember request. Require no reply write_memory, new-Thread recall and a stored entry with CellRun authority. |
| `feed` | Leave a working Thread for Feed, observe its offscreen settlement and Unread through WatchThreads, capture the drawer row. |
| `move` | Keep the phone watching streamed text, identify its resident Person owner, move that node, require the same Run, retained prefix, native owner change and a newly rendered completion marker. |

Each has `phone/<journey>/verdict.json`, public RPC receipts, numbered native command logs and named screenshots. Inspect the screenshots for the picture, unread dot/bold title and each decisive control. An assertion pass does not replace this visual check. The root phone receipt retains APK and device identity.

Use only snapshot refs from `snapshot -i --force-full` immediately before a press or fill. Preserve `~s` ref pins. Phone labels come from `apps/mobile/src`. The system Photos picker is Android-owned; retain its live snapshot and adjust its recipe if that build's semantic names differ. Never replace a phone press with an HTTP mutation.

## Limits

The Thread drawer deliberately shows title, attention dot and time, without last-message previews (`screen/home/Row.tsx`). This conflicts with the brief's preview expectation and remains a reported product difference. Screenshots establish its visual unread treatment; the public receipt establishes Unread.

The launcher does not forward VIVID_DECISIONS into Worker vars. Learning therefore uses its installed decisions-off mode, which considers every exchange. No Jev claim follows. There is no public learner-completion stream. The recipe checks CellRun memory after a real new-Thread recall, without sleeps or polling; failure can mean the background task was still pending at that observation. Report the exact observations rather than claiming it never learns.

A working Thread's thinking orb previously crashed software renderers. Provision uses `-gpu guest`. Retain crash logcat and the last snapshot when it fails. No iOS, desktop, native notification delivery or external provider account is proved by these Android recipes.

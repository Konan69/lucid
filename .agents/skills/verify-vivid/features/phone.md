# Android Thread navigation

Model requirement: none. Launch still starts the real runtime and requires its provider keys. This journey makes no model call and proves no model behaviour.

## Drive the phone

Read [Android setup](../references/android.md). Select a devbox with `~/bin/devbox-pick`. Provision it from the PC with one command, even after a snapshot restore emptied both Android directories.

```sh
.agents/skills/verify-vivid/verify android provision cloudbox-konan3
```

In the separate proof checkout on that same host, run Launch and Doctor. Then run the phone journey with the explicit run id.

```sh
.agents/skills/verify-vivid/verify phone thread flue-<id>
.agents/skills/verify-vivid/verify doctor flue-<id>
.agents/skills/verify-vivid/verify cleanup flue-<id>
```

The recipe creates one idle Thread through public `CreateThread`, installs a release APK from the recorded commit, and clears only this disposable emulator's Vivid app data. `adb reverse` maps the APK's fixed emulator loopback address to this run's own single-origin web proxy. Email sign-in uses the run's synthetic Better Auth account. It uses neither Google nor a developer account.

`agent-device` opens Vivid, waits for the actual controls, and reads `snapshot -i` before each press or fill. The journey signs in, opens the menu, captures the Thread list, selects the exact seeded Thread button by its current snapshot ref, and waits for navigation to settle and the idle composer's `Message Vivid`. Public `GetThread` confirms the same id has zero Runs and the synthetic Person is present through the phone's held `BePresent` call. The phone deliberately keeps the Thread title in the menu; presence proves which Thread is on top after the drawer closes.

## Evidence

`phone/receipt.json` records host alias, observed hostname, serial, boot identity and captured process generations. `phone/apk.json` and `phone/verdict.json` record the APK SHA-256, native fingerprint, build mode and commit. Numbered command receipts retain snapshots and the exact selected refs. `phone/threads.png` and `phone/thread.png` show the signed-in list and idle Thread. Doctor includes the phone artifact identity. `phone/cleanup.json` and `phone/ps-cleanup.json` prove the owned processes stopped.

The command holds the devbox Android lock until its finally block closes the private agent-device session, stops its daemon, removes its reverse mapping, and stops the captured emulator and adb generations. `verify cleanup` repeats recovery after a killed command. SDK, AVD and APK caches remain rebuildable.

## Limits

This proves Android email sign-in, Thread list navigation and idle rendering only. A working Thread's thinking orb has crashed software renderers in prior runs. Do not infer active conversation, rich replies, notifications, permissions, iOS or desktop coverage from this feature. Extend the recipe before making those claims.

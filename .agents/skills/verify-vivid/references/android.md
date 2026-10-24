# Set up an Android devbox

Run `~/bin/devbox-pick` on the PC. Use its selected alias with the provision command. Only cloudbox-konan, cloudbox-konan2 and cloudbox-konan3 are accepted, and the remote hostname must match `../scripts/hosts.mjs`. The production Computer is refused.

```sh
.agents/skills/verify-vivid/verify android provision cloudbox-konan3
.agents/skills/verify-vivid/verify android status cloudbox-konan3
.agents/skills/verify-vivid/verify android stop cloudbox-konan3
```

Provision requires SSH, Python 3 with pidfd, curl, unzip, flock, JDK 17 and writable `/dev/kvm` on the box. It checks load and available memory before heavy work. If KVM is inaccessible, restore the host's KVM access before retrying. A missing prerequisite is a failure.

The provisioner installs checksum-pinned Android command-line tools, the SDK package set in `../scripts/android.py`, and the API 35 Google APIs x86_64 AVD `Vivid_API_35`. It boots headless with `-gpu guest`, two cores and 3 GiB memory. It chooses a free emulator port pair, waits on adb and `sys.boot_completed`, then reads the actual adb inventory. Never assume a serial. A bounded boot-property wait exists because Android exposes no blocking boot-completed API.

The SDK lives in `~/android_sdk` and the AVD in `~/vivid-emulator`. The provisioner retains these exclusions in `~/.boxignore`; this is the one intentional write outside the skill. Boat snapshots must exclude live disks and dependency caches. A restore can empty these directories. Repeating provision reconstructs missing packages and AVD state. A healthy running device takes the fast path.

Node 24.18.1, pnpm 12.4.2 and Callstack agent-device 0.21.31 live under `~/.cache/vivid-android`. This avoids broken system symlinks after restore and does not change CLI agent settings. The CLI version is pinned from the published latest release inspected during implementation. Read its installed README and `help` before extending a recipe. Source is [Callstack agent-device](https://github.com/callstackincubator/agent-device), MIT licensed.

## Prepare the proof checkout

Use a separate checkout of the intended commit under `~/agency/vivid-lanes`. Transfer Git objects through SSH if the box has no GitHub credentials. Do not create a login. Git verifies pack checksums. Avoid copying large APKs through Boat's proxy; build them on the box.

Put the cached tools first on PATH before installing or launching the skill.

```sh
export PATH="$HOME/.cache/vivid-android/node/bin:$HOME/.cache/vivid-android/tools/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile
VIVID_VERIFY_DEVBOX=cloudbox-konan3 VIVID_VERIFY_KEY_FILE=/private/verify.env .agents/skills/verify-vivid/verify launch
```

Follow [the phone feature](../features/phone.md) for the journey. The key file contains only the explicitly supplied model credentials. No application env or existing agent login is imported.

## Build or reuse an APK

`verify phone thread` builds in its private `~/.cache/vivid-android/source` checkout. The proof checkout's product source stays untouched. Expo's shipped `scripts/native.mjs android --prebuild-only` pins the native template. Gradle uses x86_64, two workers, a 4 GiB heap, 1536 MiB metaspace, no persistent daemon, and in-process Kotlin compilation. The skill supplies an AGP init script with CMake job pools, because two Gradle workers alone do not limit Ninja compiler subprocesses.

The APK cache verifies bytes against SHA-256 before reuse. Its native fingerprint includes dependency manifests, the lockfile, patches, phone config, plugins and assets. A changed native fingerprint builds a fresh APK. When only JavaScript changes, Expo exports a new bundle and the shipped Hermes compiler compiles it. Repacking replaces only the embedded bundle, aligns the APK and signs with the generated React Native debug keystore. Asset changes require a full build. The generated test manifest permits cleartext only to 127.0.0.1 and disables OTA loading, so the embedded commit remains the code under test. This overlay is part of the native fingerprint. Cached APKs are test artifacts, never phone releases.

The pool uses [AGP finalizeDsl](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/AndroidComponentsExtension) and [CMake job pools](https://cmake.org/cmake/help/v3.22/variable/CMAKE_JOB_POOLS.html), without patching SDK internals.

The test APK uses `http://127.0.0.1:19278` only inside the disposable emulator. `adb reverse` points that address at the run's random web port. No host URL or runtime token enters product source. The dedicated adb server uses port 15037, leaving the host's ordinary adb server alone.

## Inspect through agent-device

The recipe sets `AGENT_DEVICE_STATE_DIR` to the run's private scratch directory and passes the actual serial and run session on every command. To add a phone feature, use the same context and these documented commands.

```sh
agent-device open work.vivid.mobile --platform android --serial <observed-serial> --session <run>
agent-device snapshot -i --platform android --serial <observed-serial> --session <run>
agent-device press <current-ref> --platform android --serial <observed-serial> --session <run>
agent-device screenshot <evidence>/phone/screen.png --platform android --serial <observed-serial> --session <run>
```

Invoke the pinned launcher at `~/.cache/vivid-android/tools/node_modules/agent-device/bin/agent-device.mjs` with the cached Node executable. Do not use a global daemon or another run's session. Re-snapshot after a transition before selecting another ref. Use agent-device's semantic waits. Only the latest snapshot grants ref identity.

Always finish with `verify cleanup` and, for provision-only runs, the PC's `verify android stop <alias>`. Inspect the saved process receipts and `ps` output. Stop uses PID, Linux start ticks and boot identity, so a recycled PID grants no authority.

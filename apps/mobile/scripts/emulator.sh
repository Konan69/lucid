#!/usr/bin/env bash
# The phone app on an Android emulator on a devbox, with a JavaScript change on it in about two
# minutes. Run on the devbox, from a checkout of this repository (see apps/mobile/README.md,
# "Android emulator").
#
#   emulator.sh base    build the release app for this checkout's runtimeVersion, once per native set
#   emulator.sh start   boot the emulator (KVM) and install the base app if it is not installed
#   emulator.sh ship    put this checkout's JavaScript into the base app and open it
#   emulator.sh shot F  save the settled screen to F
#   emulator.sh stop    stop the emulator this script started
#
# Why the split: a release build is a Gradle run of 15 minutes or more, and was the whole wait of
# every earlier proof, because no current build was kept and each native change (expo-symbols,
# dictation, attachments) made the last one unusable. The base app is built once per
# `runtimeVersion` (the number that names the native side, `app.json`) and kept in
# ~/vivid-phone/apk, which Boat snapshots keep; `ship` only exports the bundle, compiles it with
# Hermes and repacks it into a copy of the base app. The base app has over-the-air updates switched
# off, so it always runs the bundle it was given and never production's.
set -euo pipefail

HOME_DIR="$HOME/vivid-phone"
APKS="$HOME_DIR/apk"
WORK="$HOME_DIR/work"
AVD_NAME=Vivid_Phone
PORT=5580
SERIAL="emulator-$PORT"
SERVER="${VIVID_SERVER:-https://vivid-server-production.up.railway.app}"
MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$MOBILE/../.." && pwd)"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/android_sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-$HOME/android_sdk}"
export PATH="$HOME/.local/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
BUILD_TOOLS="$ANDROID_HOME/build-tools/35.0.0"
KEYSTORE="$MOBILE/android/app/debug.keystore"

runtime() { node -p "require('$MOBILE/app.json').expo.runtimeVersion"; }
base_apk() { echo "$APKS/vivid-$(runtime).apk"; }

# The release app for this checkout's native set, with over-the-air updates off.
base() {
  mkdir -p "$APKS"
  cd "$REPO"
  pnpm install --frozen-lockfile --filter '@vivid/mobile...'
  cd "$MOBILE"
  rm -rf android
  node scripts/native.mjs android --prebuild-only
  python3 - <<'PY'
from pathlib import Path
import xml.etree.ElementTree as XML
a = '{http://schemas.android.com/apk/res/android}'
XML.register_namespace('android', 'http://schemas.android.com/apk/res/android')
XML.register_namespace('tools', 'http://schemas.android.com/tools')
path = Path('android/app/src/main/AndroidManifest.xml')
tree = XML.parse(path)
found = [e for e in tree.getroot().find('application').findall('meta-data')
         if e.get(a + 'name') == 'expo.modules.updates.ENABLED']
assert len(found) == 1, 'expo.modules.updates.ENABLED not in the manifest'
found[0].set(a + 'value', 'false')
tree.write(path, encoding='utf-8', xml_declaration=True)
PY
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties
  (cd android && VIVID_SERVER="$SERVER" CI=1 SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease \
    --max-workers=2 --no-daemon -PreactNativeArchitectures=x86_64 \
    '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1536m')
  cp android/app/build/outputs/apk/release/app-release.apk "$(base_apk)"
  cp "$KEYSTORE" "$APKS/debug.keystore"
  echo "base $(base_apk)"
}

adb_() { adb -s "$SERIAL" "$@"; }

# Boots the emulator on KVM with the guest's own renderer: the orb's GPU work killed it under
# the host renderer (10 October 2026).
start() {
  if adb_ get-state >/dev/null 2>&1; then echo "running $SERIAL"; else
    sdkmanager --list_installed 2>/dev/null | grep -q 'system-images;android-35;google_apis;x86_64' ||
      yes | sdkmanager 'system-images;android-35;google_apis;x86_64'
    if ! avdmanager list avd -c | grep -qx "$AVD_NAME"; then
      echo no | avdmanager create avd -n "$AVD_NAME" -k 'system-images;android-35;google_apis;x86_64' --device pixel_7
      printf 'hw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\nhw.ramSize=3072\nhw.keyboard=yes\n' \
        >> "$HOME/.android/avd/$AVD_NAME.avd/config.ini"
    fi
    mkdir -p "$HOME_DIR"
    nohup setsid emulator -avd "$AVD_NAME" -port "$PORT" -cores 4 -accel on -no-window -no-audio \
      -no-boot-anim -gpu guest -no-snapshot-save > "$HOME_DIR/emulator.log" 2>&1 < /dev/null &
    echo $! > "$HOME_DIR/emulator.pid"
    adb_ wait-for-device
    until [ "$(adb_ shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 1; done
  fi
  if ! adb_ shell pm path work.vivid.mobile >/dev/null 2>&1; then
    test -f "$(base_apk)" || { echo "no base app for runtime $(runtime): run '$0 base'" >&2; exit 1; }
    adb_ install -r "$(base_apk)"
  fi
}

# This checkout's JavaScript, compiled with Hermes, in a copy of the base app.
ship() {
  local apk; apk="$(base_apk)"
  test -f "$apk" || { echo "no base app for runtime $(runtime): run '$0 base'" >&2; exit 1; }
  rm -rf "$WORK"; mkdir -p "$WORK/assets"
  cd "$REPO" && pnpm install --frozen-lockfile --filter '@vivid/mobile...' >/dev/null
  cd "$MOBILE"
  VIVID_SERVER="$SERVER" CI=1 pnpm exec expo export:embed --entry-file "$MOBILE/index.ts" --platform android \
    --dev false --bundle-output "$WORK/b.js" --assets-dest "$WORK/res" --minify false > "$WORK/export.log" 2>&1 ||
    { tail -30 "$WORK/export.log" >&2; exit 1; }
  local hermesc; hermesc=$(find "$REPO/node_modules/.pnpm" -path '*hermes-compiler*linux*' -name hermesc -type f -print -quit)
  "$hermesc" -emit-binary -O -out "$WORK/assets/index.android.bundle" "$WORK/b.js"
  cp "$apk" "$WORK/vivid.apk"
  cd "$WORK"
  zip -q -d vivid.apk 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' 'META-INF/MANIFEST.MF' || test $? = 12
  zip -q -0 vivid.apk assets/index.android.bundle
  "$BUILD_TOOLS/zipalign" -p -f 4 vivid.apk aligned.apk
  "$BUILD_TOOLS/apksigner" sign --ks "$APKS/debug.keystore" --ks-pass pass:android \
    --ks-key-alias androiddebugkey --key-pass pass:android aligned.apk
  start
  adb_ install -r aligned.apk
  adb_ shell am force-stop work.vivid.mobile
  adb_ shell am start -n work.vivid.mobile/.MainActivity >/dev/null
  echo "shipped $(git -C "$REPO" rev-parse --short HEAD) $(sha256sum assets/index.android.bundle | cut -c1-12)"
}

# The screen once two captures in a row agree; a capture taken while it still draws is blank.
shot() {
  local out="$1" last="" now
  for _ in $(seq 1 20); do
    adb_ exec-out screencap -p > "$out.tmp"
    now=$(sha256sum < "$out.tmp")
    if [ "$now" = "$last" ]; then mv "$out.tmp" "$out"; echo "$out"; return; fi
    last="$now"; sleep 1
  done
  mv "$out.tmp" "$out"; echo "$out (did not settle)"
}

# Only the emulator this script started, by the pid it kept.
stop() {
  if [ -f "$HOME_DIR/emulator.pid" ]; then kill "$(cat "$HOME_DIR/emulator.pid")" 2>/dev/null || true; rm -f "$HOME_DIR/emulator.pid"; fi
}

case "${1:-}" in
  base) base ;;
  start) start ;;
  ship) ship ;;
  shot) shot "${2:?file}" ;;
  stop) stop ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac

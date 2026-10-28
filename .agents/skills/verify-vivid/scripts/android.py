#!/usr/bin/env python3
"""Reconcile snapshot-excluded Android resources. Receipts grant authority only to spawned generations."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time

HOME = Path.home()
SDK = HOME / 'android_sdk'
AVD = HOME / 'vivid-emulator'
CACHE = HOME / '.cache/vivid-android'
BOOT = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
ENV = dict(os.environ, ANDROID_HOME=str(SDK), ANDROID_SDK_ROOT=str(SDK),
           ANDROID_AVD_HOME=str(AVD / 'avd'), ANDROID_ADB_SERVER_PORT='15037')
ADB = str(SDK / 'platform-tools/adb')
NAME = 'Vivid_API_35'
PACKAGES = ['platform-tools', 'emulator', 'platforms;android-36', 'build-tools;36.0.0',
            'platforms;android-35', 'build-tools;35.0.0', 'ndk;27.1.12297006',
            'ndk;27.0.12077973', 'cmake;3.22.1', 'system-images;android-35;google_apis;x86_64']


def run(args, **kwargs):
    """Commands fail at their real boundary; tool output goes to stderr so stdout remains one receipt."""
    return subprocess.run(args, env=ENV, check=True, text=True, stdout=sys.stderr, **kwargs)


def output(args):
    """Capture only platform receipts; provider credentials never enter these commands."""
    return subprocess.check_output(args, env=ENV, text=True).strip()


def write(path, data):
    """Atomic receipts survive partial downloads and interrupted provisioning."""
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def identity(pid):
    """Linux start ticks and boot identity distinguish PID reuse from the process we spawned."""
    stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return dict(pid=pid, start=stat[19], boot=BOOT)


def alive(receipt):
    """A zombie has exited; a new boot or start tick cannot inherit an old receipt."""
    if receipt['boot'] != BOOT:
        return False
    try:
        stat = Path(f"/proc/{receipt['pid']}/stat").read_text().rsplit(')', 1)[1].split()
        return stat[0] != 'Z' and stat[19] == receipt['start']
    except (FileNotFoundError, ProcessLookupError):
        return False


def stop(receipt):
    """pidfd binds signals and exit waiting to the captured generation, even if its PID is reused."""
    if not alive(receipt):
        return dict(process=receipt, stopped=True, absent=True)
    fd = os.pidfd_open(receipt['pid'])
    try:
        if alive(receipt):
            if os.getpgid(receipt['pid']) == receipt['pid']:
                os.killpg(receipt['pid'], signal.SIGTERM)
            else:
                signal.pidfd_send_signal(fd, signal.SIGTERM)
            if not select.select([fd], [], [], 20)[0]:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                assert select.select([fd], [], [], 10)[0], 'Owned process survived SIGKILL'
    finally:
        os.close(fd)
    return dict(process=receipt, stopped=not alive(receipt))


def spawn(role, args, receipt):
    """Journal immediately after spawn, before any boot or adb wait can fail."""
    with open(CACHE / (role + '.log'), 'ab') as log:
        child = subprocess.Popen(args, env=ENV, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
    receipt[role] = identity(child.pid)
    write(CACHE / 'device.json', receipt)
    return child


def prerequisites():
    """Snapshot exclusions are retained; rebuilding is cheaper than storing live disk snapshots."""
    ignore = HOME / '.boxignore'
    prior = ignore.read_text() if ignore.exists() else ''
    additions = [line for line in ['android_sdk/', 'vivid-emulator/', '.cache/', '.gradle/']
                 if line not in prior.splitlines()]
    if additions:
        with ignore.open('a') as file:
            file.write('\n# Rebuildable Android testing resources.\n' + '\n'.join(additions) + '\n')
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'KVM access missing; grant this user access to /dev/kvm'
    run(['java', '-version'])


def capacity():
    """Only missing resources and a cold boot need a heavy slot; a live fast path does not."""
    assert os.getloadavg()[0] <= os.cpu_count(), 'Devbox busy; choose another with devbox-pick'
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    assert int(memory['MemAvailable'].split()[0]) > 6 * 1024 * 1024, 'Devbox has less than 6 GiB available'


def install():
    """Package receipts, not a top-level marker, decide what a restore or partial install lacks."""
    manager = SDK / 'cmdline-tools/latest/bin/sdkmanager'
    if not manager.exists():
        capacity()
        SDK.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=CACHE) as temporary:
            archive = Path(temporary) / 'tools.zip'
            run(['curl', '-fL', '--retry', '3', '-o', str(archive),
                 'https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip'])
            expected = '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583'
            assert hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == expected, 'SDK checksum mismatch'
            run(['unzip', '-q', str(archive), '-d', temporary])
            (SDK / 'cmdline-tools').mkdir(exist_ok=True)
            os.rename(Path(temporary) / 'cmdline-tools', SDK / 'cmdline-tools/latest')
    missing = [name for name in PACKAGES if not (SDK / name.replace(';', '/') / 'package.xml').exists()]
    if missing:
        capacity()
        # sdkmanager has no noninteractive acceptance switch. The finite input covers its licenses.
        run([str(manager), '--sdk_root=' + str(SDK), '--licenses'], input='y\n' * 100)
        run([str(manager), '--sdk_root=' + str(SDK), *missing], input='y\n' * 100)
    avds = AVD / 'avd'
    avds.mkdir(parents=True, exist_ok=True)
    if not (avds / (NAME + '.avd/config.ini')).exists():
        capacity()
        run([str(manager.with_name('avdmanager')), 'create', 'avd', '--force', '-n', NAME,
             '-k', PACKAGES[-1], '--device', 'pixel_7'], input='no\n')
    return missing


def server(receipt):
    """Reconcile adb before any client can auto-fork a replacement outside our PID receipt."""
    # adb's dedicated server avoids restarting another worktree's system adb daemon.
    if 'adb' not in receipt or not alive(receipt['adb']):
        with socket.socket() as probe:
            assert probe.connect_ex(('127.0.0.1', 15037)) != 0, 'Private adb port occupied without receipt'
        spawn('adb', [ADB, '-L', 'tcp:15037', 'server', 'nodaemon'], receipt)
        deadline = time.monotonic() + 10
        while True:
            assert alive(receipt['adb']), 'Owned adb server exited before binding'
            with socket.socket() as probe:
                if probe.connect_ex(('127.0.0.1', 15037)) == 0:
                    break
            assert time.monotonic() < deadline, 'Owned adb server did not bind within 10 seconds'
            # adb nodaemon has no readiness fd. Only an observed listener permits commands.
            select.select([], [], [], 0.05)


def boot(receipt):
    """A live emulator may outlive adb. Reconnect its observed serial through the owned server."""
    server(receipt)
    if 'emulator' in receipt and alive(receipt['emulator']):
        ready(receipt)
        return
    capacity()
    port = None
    for candidate in range(5554, 5680, 2):
        with socket.socket() as first, socket.socket() as second:
            try:
                first.bind(('127.0.0.1', candidate))
                second.bind(('127.0.0.1', candidate + 1))
                port = candidate
                break
            except OSError:
                continue
    assert port is not None, 'No emulator port pair available'
    receipt['serial'] = 'emulator-' + str(port)
    spawn('emulator', [str(SDK / 'emulator/emulator'), '-avd', NAME, '-port', str(port),
                      '-no-window', '-gpu', 'swiftshader', '-no-audio', '-no-snapshot',
                      '-no-boot-anim', '-cores', '2', '-memory', '3072'], receipt)
    ready(receipt)


def ready(receipt):
    """Only adb connection, Android's boot property and the current inventory grant readiness."""
    # adb supplies the connection signal. Android exposes no blocking boot-completed API.
    # This bounded platform-property wait fails after 5 minutes; elapsed time never means ready.
    run(['timeout', '300', ADB, '-s', receipt['serial'], 'wait-for-device'])
    run(['timeout', '300', ADB, '-s', receipt['serial'], 'shell',
         'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'])
    assert alive(receipt['adb']), 'Private adb server lost ownership'
    inventory = output([ADB, 'devices'])
    assert receipt['serial'] + '\tdevice' in inventory, inventory
    receipt['inventory'] = inventory
    run([ADB, '-s', receipt['serial'], 'shell', 'input', 'keyevent', '82'])
    # Configure accessibility before Vivid starts; the orb reads Android's reduced-motion state.
    settings = ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']
    for setting in settings:
        run([ADB, '-s', receipt['serial'], 'shell', 'settings', 'put', 'global', setting, '0'])
    motion = {setting: output([ADB, '-s', receipt['serial'], 'shell', 'settings', 'get',
                              'global', setting]) for setting in settings}
    assert all(value == '0' for value in motion.values()), motion
    write(CACHE / 'motion.json', dict(serial=receipt['serial'], boot=BOOT, settings=motion))
    write(CACHE / 'device.json', receipt)


def main():
    """Host identity and the host lock precede every SDK mutation or captured-process stop."""
    action, alias, expected = sys.argv[1:]
    assert alias in ['cloudbox-konan', 'cloudbox-konan2', 'cloudbox-konan3'], 'Unknown devbox'
    assert expected != 'bx_yjj2hakd' and os.environ.get('BOAT_ID') == expected, 'Host identity mismatch'
    CACHE.mkdir(parents=True, exist_ok=True)
    with open(CACHE / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lease = CACHE / 'lease.json'
        if action != 'status' and lease.exists():
            raise RuntimeError('A proof run owns this emulator; use verify cleanup in its checkout')
        location = CACHE / 'device.json'
        receipt = json.loads(location.read_text()) if location.exists() else {}
        started = time.monotonic()
        if action == 'stop':
            result = [stop(receipt[role]) for role in ['emulator', 'adb'] if role in receipt]
            write(CACHE / 'cleanup.json', result)
            print(json.dumps(dict(stopped=result)))
            return
        if action == 'status':
            print(json.dumps(dict(receipt=receipt, leased=lease.exists(), alive={key: alive(receipt[key])
                  for key in ['emulator', 'adb'] if key in receipt})))
            return
        assert action == 'provision', 'Choose provision, status or stop'
        prerequisites()
        try:
            missing = install()
            boot(receipt)
        except BaseException:
            for role in ['emulator', 'adb']:
                if role in receipt:
                    stop(receipt[role])
            raise
        receipt.update(alias=alias, hostname=socket.gethostname(), seconds=round(time.monotonic() - started, 3),
                       installed=missing, sdk=str(SDK), avd=str(AVD), boot=BOOT)
        write(location, receipt)
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()

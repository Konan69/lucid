#!/usr/bin/env python3
"""Record the PC's running Windows emulator as the phone device. The run owns neither the
emulator nor the PC's adb server, so this receipt carries no process authority to stop them."""
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

HOME = Path.home()
SDK = HOME / 'android_sdk'
CACHE = HOME / '.cache/vivid-android'
BOOT = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
PORT = os.environ.get('ANDROID_ADB_SERVER_PORT', '5037')
ENV = dict(os.environ, ANDROID_HOME=str(SDK), ANDROID_SDK_ROOT=str(SDK), ANDROID_ADB_SERVER_PORT=PORT)
ADB = str(SDK / 'platform-tools/adb')
# The QEMU host renderer segfaulted on these as soon as the thinking orb drew (devbox report).
SOFTWARE = ['swiftshader', 'llvmpipe', 'lavapipe']


def output(args):
    """adb reads against a vanished guest can wait indefinitely; the bound reports it instead."""
    return subprocess.check_output(['timeout', '30', ADB, *args], env=ENV, text=True).strip()


def write(path, data):
    """Atomic receipts survive an interrupted attach."""
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def identity(expected):
    """The same checks as settings.mjs host(): WSL on the registered PC, never a Boat sandbox."""
    assert 'BOAT_ID' not in os.environ, 'PC host mode refused on a Boat sandbox'
    assert 'microsoft-standard-WSL2' in Path('/proc/sys/kernel/osrelease').read_text(), 'Not WSL'
    assert Path('/etc/machine-id').read_text().strip() == expected, 'Not the registered PC'


def attach(serial):
    """Only adb's inventory, Android's boot property and a hardware renderer grant readiness."""
    inventory = output(['devices'])
    assert serial + '\tdevice' in inventory.splitlines(), inventory
    assert output(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) == '1', 'Boot incomplete'
    # SurfaceFlinger names the GLES implementation the guest composes with: the host GPU
    # through the emulator's translator, or a software rasterizer.
    renderer = next(line.strip() for line in output(['-s', serial, 'shell', 'dumpsys', 'SurfaceFlinger'])
                    .splitlines() if line.strip().startswith('GLES:'))
    assert not any(name in renderer.lower() for name in SOFTWARE), \
        'Emulator renders in software; start it with -gpu host: ' + renderer
    # The console's `avd name` needs the Windows console token; the guest property does not.
    avd = output(['-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'])
    assert avd, 'Guest reports no AVD name'
    output(['-s', serial, 'shell', 'input', 'keyevent', '82'])
    # Configure accessibility before Vivid starts; the orb reads Android's reduced-motion state.
    settings = ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']
    for setting in settings:
        output(['-s', serial, 'shell', 'settings', 'put', 'global', setting, '0'])
    motion = {setting: output(['-s', serial, 'shell', 'settings', 'get', 'global', setting])
              for setting in settings}
    assert all(value == '0' for value in motion.values()), motion
    write(CACHE / 'motion.json', dict(serial=serial, boot=BOOT, settings=motion))
    receipt = dict(_tag='pc', serial=serial, alias='pc', hostname=socket.gethostname(), boot=BOOT,
                   sdk=str(SDK), adbPort=int(PORT), avd=avd, renderer=renderer, inventory=inventory)
    write(CACHE / 'device.json', receipt)
    return receipt


def main():
    """The host lock and the run lease precede every receipt write, as in android.py."""
    action, expected, *rest = sys.argv[1:]
    identity(expected)
    CACHE.mkdir(parents=True, exist_ok=True)
    with open(CACHE / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lease = CACHE / 'lease.json'
        location = CACHE / 'device.json'
        if action == 'status':
            receipt = json.loads(location.read_text()) if location.exists() else {}
            print(json.dumps(dict(receipt=receipt, leased=lease.exists())))
            return
        assert action == 'attach' and len(rest) == 1, 'verify android attach pc <serial>'
        if lease.exists():
            raise RuntimeError('A proof run owns this emulator; use verify cleanup in its checkout')
        print(json.dumps(attach(rest[0])))


if __name__ == '__main__':
    main()

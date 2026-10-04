#!/usr/bin/env python3
"""Configure native Xfce launchers, keeping application icons and vendor desktop services.

This is Boat template configuration, not a Vivid view. The installed app finder supplies the app list;
the native panel's launcher plugin pins the provider's actual browser, terminal and files app.
"""
import fcntl
import os
import pathlib
import re
import subprocess
import shutil
import sys


def configure(home):
    """Seed one home without overwriting a Person's later panel customizations."""
    autostart = home / '.config/autostart'
    autostart.mkdir(parents=True, exist_ok=True)
    # Boat restores its native Openbox session; XDG autostart starts the same native panel
    # and app catalogue on every desktop login, without replacing its display/driver service.
    for name, command in [('panel', 'xfce4-panel --disable-wm-check'),
                          ('applications', 'xfce4-appfinder --expanded --disable-server')]:
        (autostart / ('vivid-' + name + '.desktop')).write_text(
            '[Desktop Entry]\nType=Application\nName=Applications\nExec=' + command + '\n')
    configuration = home / '.config/xfce4' 
    panel = configuration / 'xfconf/xfce-perchannel-xml/xfce4-panel.xml'
    if panel.exists():
        return
    panel.parent.mkdir(parents=True, exist_ok=True)
    applications = pathlib.Path('/usr/share/applications')
    browser = 'google-chrome.desktop' if (applications / 'google-chrome.desktop').exists() else 'chromium.desktop'
    launchers = [browser, 'xfce4-terminal.desktop', 'thunar.desktop']
    plugins = []
    for identifier, application in enumerate(launchers, start=2):
        directory = configuration / ('panel/launcher-' + str(identifier))
        directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(applications / application, directory / application)
        plugins.append('<property name="plugin-' + str(identifier) + '" type="string" value="launcher">'
            '<property name="items" type="array"><value type="string" value="' + application + '"/></property></property>')
    panel.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfce4-panel" version="1.0">'
        '<property name="configver" type="int" value="2"/>'
        '<property name="panels" type="array"><value type="int" value="1"/>'
        '<property name="panel-1" type="empty">'
        '<property name="position" type="string" value="p=10;x=640;y=780"/>'
        '<property name="position-locked" type="bool" value="true"/>'
        '<property name="size" type="uint" value="40"/>'
        '<property name="length" type="uint" value="100"/>'
        '<property name="plugin-ids" type="array">'
        '<value type="int" value="1"/><value type="int" value="2"/>'
        '<value type="int" value="3"/><value type="int" value="4"/>'
        '<value type="int" value="5"/></property></property></property>'
        '<property name="plugins" type="empty">'
        '<property name="plugin-1" type="string" value="applicationsmenu"/>' + ''.join(plugins) +
        '<property name="plugin-5" type="string" value="tasklist"/>'
        '</property></channel>')


def start():
    """Show the native app finder once per Boat desktop session, keeping its existing dock.

    Boat's native desktop launches Openbox directly, without XDG autostart. The provider
    calls this after readiness. Session attestation follows boat/guest.ts guestCommand:
    X11 proves the desktop owner's PID before copying only its display/bus/runtime values.
    No vendor process or startup file is modified, and closing the launcher is respected.
    """
    windows = subprocess.check_output(['xprop', '-root', '_NET_CLIENT_LIST'], text=True)
    owners = set()
    for window in re.findall(r'0x[0-9a-f]+', windows):
        properties = subprocess.check_output(['xprop', '-id', window, '_NET_WM_PID', 'WM_CLASS'], text=True)
        if '"AsciiDesktop"' in properties:
            match = re.search(r'_NET_WM_PID\(CARDINAL\) = ([0-9]+)', properties)
            if match is None:
                raise ValueError('Computer desktop ownership unavailable')
            owners.add(int(match.group(1)))
    if len(owners) != 1:
        raise ValueError('Computer desktop identity ambiguous')
    owner = owners.pop()
    entries = pathlib.Path('/proc/' + str(owner) + '/environ').read_bytes().split(b'\0')
    environment = dict(item.decode().split('=', 1) for item in entries if b'=' in item)
    required = ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
    if not all(environment.get(name) for name in required):
        raise ValueError('Computer desktop session unavailable')
    session = {**os.environ, **{name: environment[name] for name in required}}
    marker = pathlib.Path(session['XDG_RUNTIME_DIR']) / 'vivid-applications'
    with marker.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lock.seek(0)
        if lock.read() == str(owner):
            return
        subprocess.run(['systemd-run', '--user', '--unit=vivid-computer-applications',
            '--service-type=exec', '--collect',
            *['--setenv=' + name + '=' + session[name] for name in required],
            'xfce4-appfinder', '--expanded', '--disable-server'], env=session, check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        lock.seek(0)
        lock.truncate()
        lock.write(str(owner))


if sys.argv[1] == 'start':
    start()
else:
    configure(pathlib.Path(sys.argv[1]))

#!/usr/bin/env python3
"""One Boat release catalogue drives preparation and live inventory.

Inventory probes executables, distro packages and Python imports every time: an old template or
removed application cannot turn a release wish list into a claim of installed software.
"""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
CATALOGUE = json.loads((ROOT / 'apps.json').read_text())


def packages():
    """Resolve Boat preparation packages from the authoritative app catalogue."""
    return sorted(set(CATALOGUE['support'] + [p for app in CATALOGUE['apps'] for p in app['packages']]))


def installed():
    """Return only entries whose programs, package payloads and native launchers exist."""
    result = []
    for app in CATALOGUE['apps']:
        binaries = any(shutil.which(command) for command in app['commands'])
        payloads = all(subprocess.run(['dpkg-query', '-W', '-f=${Status}', package],
            capture_output=True, text=True).stdout == 'install ok installed' for package in app['packages'])
        launchers = not app['desktop'] or any((pathlib.Path('/usr/share/applications') / name).is_file()
            for name in app['desktop'])
        if binaries and payloads and launchers:
            result.append({'name': app['name'], 'purpose': app['purpose']})
    return result


def verify():
    """Fail the prepared machine before capture if any declared app or required library is absent."""
    present = {app['name'] for app in installed()}
    missing = [app['name'] for app in CATALOGUE['apps'] if app['name'] not in present]
    missing += [name for name in ['openpyxl', 'docx', 'pptx', 'pypdf', 'reportlab', 'PIL']
        if importlib.util.find_spec(name) is None]
    if missing:
        sys.exit('Missing Computer applications: ' + ', '.join(missing))


if __name__ == '__main__':
    operation = sys.argv[1]
    if operation == 'packages':
        print('\n'.join(packages()))
    elif operation == 'python':
        print('\n'.join(CATALOGUE['python']))
    elif operation == 'verify':
        verify()
    elif operation == 'inventory':
        print(json.dumps({'_tag': 'Installed', 'apps': installed()}))
    else:
        sys.exit('Unknown catalogue operation')

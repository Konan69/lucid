#!/usr/bin/env python3
"""Install upstream engineering releases identically on Debian and Ubuntu.

Ubuntu Noble has no FreeCAD package in Boat's repository. Extract the official AppImage to
avoid FUSE/root requirements; Slicer uses its official tar release. Both are checksum pinned.
The native .desktop entries use each application's own icon, not Vivid artwork.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent


def install(archive):
    """Validate each download before extracting into a dedicated immutable installation."""
    destination = ROOT / archive['directory']
    if not (destination / archive['entry']).exists():
        extract(archive, destination)
    command = pathlib.Path('/usr/local/bin') / archive['command']
    if command.is_symlink():
        if command.readlink() != destination / archive['entry']:
            raise ValueError('Computer application command belongs to another installation')
    else:
        command.symlink_to(destination / archive['entry'])
    icon = destination / archive['icon']
    if not icon.is_file():
        raise ValueError('Computer application icon missing: ' + archive['name'])
    launcher = pathlib.Path('/usr/share/applications') / archive['desktop']
    launcher.write_text('[Desktop Entry]\nType=Application\nName=' + archive['name'] +
        '\nExec=' + str(command) + '\nIcon=' + str(icon) + '\nCategories=Graphics;Science;\nTerminal=false\n')


def extract(archive, destination):
    """Copy file-by-file into final paths so Boat captures the complete payload.

    A live named-snapshot/resume on 4 October restored renamed directories empty while
    retaining their launchers. Explicit final-path writes avoid that observed snapshot gap.
    Same-filesystem staging also avoids /tmp-to-/opt cross-device moves on Boat.
    """
    with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
        download = pathlib.Path(temporary) / 'release'
        with urllib.request.urlopen(archive['url'], timeout=120) as response, download.open('wb') as output:
            while content := response.read(1024 * 1024):
                output.write(content)
        with download.open('rb') as source:
            digest = hashlib.file_digest(source, archive['algorithm']).hexdigest()
        if digest != archive['digest']:
            raise ValueError('Computer application checksum mismatch: ' + archive['name'])
        if archive['format'] == 'appimage':
            download.chmod(0o755)
            subprocess.run([str(download), '--appimage-extract'], cwd=temporary,
                stdout=subprocess.DEVNULL, check=True)
            shutil.copytree(pathlib.Path(temporary) / 'squashfs-root', destination, symlinks=True, dirs_exist_ok=True)
        else:
            with tarfile.open(download) as package:
                package.extractall(temporary, filter='data')
            directories = [p for p in pathlib.Path(temporary).iterdir() if p.is_dir()]
            if len(directories) != 1:
                raise ValueError('Computer application archive layout invalid')
            shutil.copytree(directories[0], destination, symlinks=True, dirs_exist_ok=True)



for entry in json.loads((ROOT / 'apps.json').read_text())['archives']:
    install(entry)

"""Install phone tooling under the snapshot-excluded cache, without changing agent configuration."""
import hashlib
import json
from pathlib import Path
import os
import subprocess
import sys
import tarfile
import tempfile


def tools():
    """Recognize partial extraction so a restore or interrupted bootstrap can converge."""
    cache = Path.home() / '.cache/vivid-android'
    cache.mkdir(parents=True, exist_ok=True)
    node = cache / 'node'
    if (node / 'release/bin/node').exists() and not (node / 'bin').exists():
        (node / 'bin').symlink_to('release/bin')
    if not (node / 'bin/node').exists():
        with tempfile.TemporaryDirectory(dir=cache) as directory:
            archive = Path(directory) / 'node.tar.xz'
            subprocess.run(['curl', '-fL', '--retry', '3', '-o', str(archive),
                            'https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.xz'], check=True)
            expected = 'd6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0'
            with archive.open('rb') as file:
                assert hashlib.file_digest(file, 'sha256').hexdigest() == expected, 'Node checksum mismatch'
            with tarfile.open(archive) as file:
                file.extractall(directory, filter='data')
            node.mkdir(exist_ok=True)
            os.rename(Path(directory) / 'node-v24.18.1-linux-x64', node / 'release')
            (node / 'bin').symlink_to('release/bin')
    environment = dict(os.environ, PATH=str(node / 'bin') + ':' + os.environ['PATH'])
    target = cache / 'tools'
    target.mkdir(exist_ok=True)
    package = target / 'package.json'
    wanted = {'private': True, 'dependencies': {'agent-device': '0.21.31', 'pnpm': '12.4.2'}}
    if not package.exists() or json.loads(package.read_text()) != wanted:
        package.write_text(json.dumps(wanted))
    versions = [target / 'node_modules' / name / 'package.json' for name in wanted['dependencies']]
    installed = all(file.exists() and json.loads(file.read_text()).get('version') == version
                    for file, version in zip(versions, wanted['dependencies'].values()))
    if not installed:
        subprocess.run(['pnpm', '--dir', str(target), 'install', '--ignore-scripts', '--no-frozen-lockfile'],
                       env=environment, check=True, stdout=sys.stderr)
    print(json.dumps({'node': str(node / 'bin/node'),
                      'pnpm': str(target / 'node_modules/pnpm/bin/pnpm.mjs'),
                      'device': str(target / 'node_modules/agent-device/bin/agent-device.mjs')}))


if __name__ == '__main__':
    tools()

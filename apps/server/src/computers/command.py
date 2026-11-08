"""Computer shell handles: detached command, output files and terminal receipt.

Adapts grok-bot-prompt.md K22/K24 and gpt-6-astra.md R0727/R0884 shell
contracts. Their backend implementations were not present in the captures. Vivid keeps the completion obligation in
its server SQL queue; this supervisor and its files survive that server restarting.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys

encoded_source, action, identity, encoded = sys.argv[1:]
source = base64.b64decode(encoded_source).decode()
root = Path.home() / '.vivid' / 'commands' / identity
statefile = root / 'state.json'


def save(state):
    """Rename one complete receipt; readers never see a partially written JSON file."""
    temporary = root / f'{os.getpid()}.json'
    temporary.write_text(json.dumps(state))
    temporary.replace(statefile)


def lifetime(pid):
    """Linux start ticks distinguish a recorded process from a reused numeric pid."""
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except FileNotFoundError:
        return None


def snapshot():
    """Keep whole output on disk, returning only each stream's last 25 KiB."""
    if not statefile.exists():
        return {'_tag': 'Missing'}
    state = json.loads(statefile.read_text())
    if state['_tag'] == 'Running' and lifetime(state['pid']) != state['birth']:
        state = {'_tag': 'Unknown'}
    result = {'_tag': state['_tag'], 'handle': identity}
    if state['_tag'] == 'Completed':
        result['exitCode'] = state['exitCode']
    result['truncated'] = False
    for name in ('stdout', 'stderr'):
        path = root / name
        with path.open('rb') as stream:
            size = stream.seek(0, 2)
            stream.seek(max(0, size - 25600))
            result[name] = stream.read().decode('utf-8', errors='replace')
            result['truncated'] |= size > 25600
    result['outputDirectory'] = str(root)
    return result


def supervise():
    """Own the child group and receipt independently of the SSH or server lifetime."""
    request = json.loads(base64.b64decode(encoded))
    ready = int(request['ready'])
    stopped = False
    child = None

    def stop(_signum, _frame):
        """Only kill the group spawned here, while its leader is still our child."""
        nonlocal stopped
        stopped = True
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)

    signal.signal(signal.SIGTERM, stop)
    with (root / 'stdout').open('wb') as stdout, (root / 'stderr').open('wb') as stderr:
        save({'_tag': 'Running', 'pid': os.getpid(), 'birth': lifetime(os.getpid())})
        os.write(ready, b'1')
        os.close(ready)
        # A stop arriving before spawn is also terminal and must never start work afterward.
        if not stopped:
            try:
                child = subprocess.Popen(['bash', '-lc', request['command']],
                                         cwd=request['directory'], stdout=stdout, stderr=stderr,
                                         start_new_session=True)
                if stopped:
                    stop(signal.SIGTERM, None)
                code = child.wait()
            except OSError as error:
                stderr.write(str(error).encode())
                code = 127
        else:
            code = -signal.SIGKILL
    save({'_tag': 'Stopped'} if stopped else {'_tag': 'Completed', 'exitCode': code})


def start():
    """A per-handle lock and reservation make lost launch receipts safe to retry.

    A reservation without a Running receipt is uncertain, never permission to rerun
    a command. The queue will deliver Unknown instead of duplicating side effects.
    """
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not statefile.exists():
            (root / 'stdout').touch()
            (root / 'stderr').touch()
            save({'_tag': 'Unknown'})
            reading, writing = os.pipe()
            request = json.loads(base64.b64decode(encoded))
            request['ready'] = writing
            payload = base64.b64encode(json.dumps(request).encode()).decode()
            subprocess.Popen([sys.executable, '-c', source, encoded_source, 'supervise', identity, payload],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True,
                             pass_fds=(writing,))
            os.close(writing)
            os.read(reading, 1)
            os.close(reading)
    return snapshot()


def observe():
    """pidfd waits on this exact supervisor's exit; it also prevents pid-reuse kills."""
    if not statefile.exists():
        return snapshot()
    state = json.loads(statefile.read_text())
    if state['_tag'] == 'Running':
        try:
            descriptor = os.pidfd_open(state['pid'])
        except ProcessLookupError:
            return snapshot()
        with os.fdopen(descriptor, 'rb') as process:
            if lifetime(state['pid']) == state['birth']:
                if action == 'stop':
                    signal.pidfd_send_signal(process.fileno(), signal.SIGTERM)
                if action in ('wait', 'stop'):
                    select.select([process], [], [], int(encoded))
    return snapshot()


if action == 'supervise':
    supervise()
else:
    print(json.dumps(start() if action == 'start' else observe()))

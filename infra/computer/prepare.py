#!/usr/bin/env python3
"""Prepare a fresh, credential-free Boat machine once and freeze a release template.

The private receipt retains the original create intent and exact provider id across reruns.
Only this newly created id is written or stopped. Named snapshot publication follows verified
installation; reruns reuse the id and installer marker rather than creating another machine.
Boat v1 CreateSandboxRequest.from and /named-snapshots are the preparation mechanism.
"""
import json
import os
import pathlib
import time
import urllib.request
import uuid

STARTED = time.monotonic()
ROOT = pathlib.Path(__file__).resolve().parent
RECEIPT = pathlib.Path('artifacts/night/computer-preparation.json')
TEMPLATE = os.environ['VIVID_BOAT_TEMPLATE']
if not TEMPLATE.startswith('vivid-computer-') or not 16 <= len(TEMPLATE) <= 63 or not all(c.islower() or c.isdigit() or c == '-' for c in TEMPLATE):
    raise ValueError('Use a new versioned vivid-computer- template name')


def request(path, body=None, intent=None):
    """Send only bounded preparation calls; authorization is never printed or saved."""
    headers = {'Authorization': 'Bearer ' + os.environ['VIVID_BOAT_API_KEY'],
        'Content-Type': 'application/json', 'Connection': 'close'}
    if intent is not None:
        headers['Idempotency-Key'] = intent
    if 'VIVID_BOAT_ORG' in os.environ:
        headers['X-Boat-Org'] = os.environ['VIVID_BOAT_ORG']
    data = None if body is None else json.dumps(body).encode()
    outgoing = urllib.request.Request('https://boat.dev/api/v1' + path, data=data, headers=headers)
    with urllib.request.urlopen(outgoing, timeout=660) as response:
        reply = json.load(response)
    if reply['ok'] is not True:
        raise ValueError('Boat preparation request refused')
    return reply


def command(script, seconds=60):
    """A lost command receipt stops preparation, so unsafe shell work is never replayed automatically."""
    receipt = request('/sandboxes/' + machine + '/commands', {'command': script,
        'timeoutSeconds': seconds, 'detached': False, 'stream': False})
    if receipt['exitCode'] != 0 or receipt['timedOut']:
        raise ValueError('Computer preparation command failed: ' + receipt['stderr'][-2000:])
    return receipt['stdout']


def wait_for(read, ready, failed, deadline_seconds):
    """Provider lifecycle has no event stream; observe its documented state with a bounded deadline."""
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        state = read()
        if ready(state):
            return state
        if failed(state):
            raise ValueError('Computer preparation failed')
        time.sleep(3)
    raise TimeoutError('Computer preparation deadline expired')


RECEIPT.parent.mkdir(parents=True, exist_ok=True)
if not RECEIPT.exists():
    RECEIPT.write_text(json.dumps({'intent': str(uuid.uuid4())}))
    RECEIPT.chmod(0o600)
saved = json.loads(RECEIPT.read_text())
if 'id' not in saved:
    created = request('/sandboxes', {'type': 'default', 'ttlSeconds': 7200,
        'noEnv': True, 'snapshots': True}, saved['intent'])
    saved['id'] = created['sandbox']['id']
    RECEIPT.write_text(json.dumps(saved))
machine = saved['id']
if machine == 'bx_czvuupbf':
    raise ValueError('Protected Computer cannot be prepared')
current = request('/sandboxes/' + machine)['sandbox']
if current['name'] in ['cloudbox-konan', 'upwork-apply']:
    raise ValueError('Protected Computer cannot be prepared')
if current['state'] == 'archived':
    request('/sandboxes/' + machine + '/resume', {'ttlSeconds': 7200, 'noEnv': True})
print('Preparation Computer:', machine, flush=True)
wait_for(lambda: request('/sandboxes/' + machine)['sandbox'],
    lambda s: s['state'] in ['ready', 'running', 'idle'],
    lambda s: s['state'] in ['error', 'cancelled', 'archived'], 180)
# Shell interpreters may read a script incrementally. Never replace installer files under
# an earlier in-flight preparation; wait for that owned unit before uploading a revision.
wait_for(lambda: command('if systemctl is-active --quiet vivid-computer-preparation; '
    'then echo busy; else echo idle; fi').strip(), lambda s: s == 'idle', lambda s: False, 3600)
command('mkdir -p /tmp/vivid-preparation')
for name in ['apps.json', 'catalogue.py', 'archives.py', 'install', 'desktop.py']:
    # Files API's upload verb is PUT, unlike command/snapshot POST.
    body = json.dumps({'path': '/tmp/vivid-preparation/' + name,
        'content': (ROOT / name).read_text(), 'encoding': 'utf8'}).encode()
    outgoing = urllib.request.Request('https://boat.dev/api/v1/sandboxes/' + machine + '/files',
        data=body, method='PUT', headers={'Authorization': 'Bearer ' + os.environ['VIVID_BOAT_API_KEY'],
        'Content-Type': 'application/json', 'Connection': 'close',
        **({'X-Boat-Org': os.environ['VIVID_BOAT_ORG']} if 'VIVID_BOAT_ORG' in os.environ else {})})
    with urllib.request.urlopen(outgoing, timeout=60) as response:
        if json.load(response)['success'] is not True:
            raise ValueError('Computer preparation file upload failed')
command('sudo mkdir -p /opt/vivid/computer; sudo cp /tmp/vivid-preparation/* /opt/vivid/computer/; '
    'sudo chmod 755 /opt/vivid/computer/install')
print('Installing apps; preparation only, new Computers will restore the snapshot.', flush=True)
# The native command deadline is ten minutes. A dedicated system unit retains long installation
# independently of HTTP; marker files establish completion, rather than guessing from elapsed time.
command('if systemctl is-active --quiet vivid-computer-preparation; then true; '
    'elif systemctl is-failed --quiet vivid-computer-preparation || '
    '! test -f /opt/vivid/computer/measurement.json || '
    '! /opt/vivid/python/bin/python3 /opt/vivid/computer/catalogue.py verify >/dev/null 2>&1; then '
    'sudo rm -f /opt/vivid/computer/measurement.json; '
    'sudo systemctl reset-failed vivid-computer-preparation; '
    'sudo systemd-run --unit=vivid-computer-preparation --service-type=exec '
    '/opt/vivid/computer/install; fi')
wait_for(lambda: command('if systemctl is-active --quiet vivid-computer-preparation; then echo running; '
    'elif systemctl is-failed --quiet vivid-computer-preparation; then echo failed; '
    'elif test -f /opt/vivid/computer/measurement.json; then echo done; '
    'else echo failed; fi').strip(), lambda s: s == 'done', lambda s: s == 'failed', 3600)
command('python3 /opt/vivid/computer/desktop.py "$HOME"')
command('/opt/vivid/python/bin/python3 /opt/vivid/computer/catalogue.py verify')
print(command('cat /opt/vivid/computer/measurement.json'), flush=True)
request('/named-snapshots', {'sandboxId': machine, 'name': TEMPLATE})
snapshot = wait_for(lambda: request('/named-snapshots/' + TEMPLATE)['snapshot'],
    lambda s: s['status'] == 'ready', lambda s: s['status'] == 'failed', 1200)
print('Template ready:', TEMPLATE, 'bytes:', snapshot['sizeBytes'], flush=True)
request('/sandboxes/' + machine + '/stop', {'force': False})
wait_for(lambda: request('/sandboxes/' + machine)['sandbox'],
    lambda s: s['state'] == 'archived', lambda s: s['state'] in ['error', 'cancelled'], 180)
print('Preparation Computer archived; set VIVID_BOAT_TEMPLATE=' + TEMPLATE, flush=True)
print('Preparation seconds:', round(time.monotonic() - STARTED, 1), flush=True)

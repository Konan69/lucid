import { Effect, Schema } from 'effect'
import { MachineOperationFailed, MachineResponseInvalid, type MachineKey } from '../machine.ts'
import { driver } from './driver.ts'
import type { ProviderId } from './protocol.ts'
import type { Transport } from './transport.ts'

/** Boat images differ: one has a Cua daemon on the wrong session bus; another has no binary.
 * Own a SHA-256-pinned 0.23.2 installation on the persistent home and launch only that binary
 * through its public serve API in the X11-attested desktop panel's session. Source: tagged
 * cua-driver-core CLI and platform-linux/src/atspi/native.rs; never patch vendor internals.
 * Standard existing-profile authorization stays fixed. /run holds the owned unit/socket and
 * generation; inotify proves readiness, and the lock makes concurrent servers share one unit.
 * This prerequisite is removable once Boat guarantees a compatible driver and desktop bus. */
export const guestCommand = String.raw`python3 - <<'VIVID_DRIVER'
import ctypes as c, fcntl, hashlib, io, json, os, pathlib, re, select, subprocess, tarfile, time, urllib.request
# X11 attests the panel's owning PID; only its desktop environment is copied.
windows=subprocess.check_output(['xprop','-root','_NET_CLIENT_LIST'],text=True)
pids=set()
for window in re.findall(r'0x[0-9a-f]+',windows):
 properties=subprocess.check_output(['xprop','-id',window,'_NET_WM_PID','WM_CLASS'],text=True)
 if '"AsciiDesktop"' in properties:
  match=re.search(r'_NET_WM_PID\(CARDINAL\) = ([0-9]+)',properties)
  if not match: raise RuntimeError('desktop ownership unavailable')
  pids.add(int(match.group(1)))
if len(pids) != 1: raise RuntimeError('desktop identity ambiguous')
pid=pids.pop()
entries=pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
environment=dict(item.decode().split('=',1) for item in entries if b'=' in item)
required=['DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR']
if not all(environment.get(name) for name in required): raise RuntimeError('desktop session unavailable')
env=os.environ.copy(); env.update({name:environment[name] for name in required})
runtime=pathlib.Path(env['XDG_RUNTIME_DIR'])
endpoint=runtime/'vivid-driver.sock'
installation=pathlib.Path.home()/'.local/share/vivid/computer'
installation.mkdir(mode=0o700,parents=True,exist_ok=True)
binary=installation/'driver'
with (runtime/'vivid-driver.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 if not binary.exists():
  url='https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.23.2/cua-driver-rs-0.23.2-linux-x86_64-binary.tar.gz'
  with urllib.request.urlopen(url,timeout=60) as response: archive=response.read()
  if hashlib.sha256(archive).hexdigest() != '01bf8339ec129cc00f4b4b2c6056ef1a7c5b52df39ff83ad17c9b16818aec500': raise RuntimeError('driver checksum invalid')
  with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as package:
   member=package.getmember('cua-driver')
   if not member.isfile(): raise RuntimeError('driver package invalid')
   with package.extractfile(member) as source: content=source.read()
  temporary=installation/'driver.new'
  temporary.write_bytes(content); temporary.chmod(0o700); temporary.replace(binary)
 if subprocess.check_output([str(binary),'--version'],text=True).strip() != 'cua-driver 0.23.2': raise RuntimeError('driver version invalid')
 active=subprocess.run(['systemctl','--user','is-active','--quiet','vivid-computer-driver'],env=env).returncode == 0
 if not active:
  if endpoint.exists(): endpoint.unlink()
  libc=c.CDLL(None,use_errno=True)
  watch=libc.inotify_init1(os.O_CLOEXEC)
  if watch < 0: raise RuntimeError('driver readiness unavailable')
  try:
   if libc.inotify_add_watch(watch,str(runtime).encode(),0x100|0x80) < 0: raise RuntimeError('driver readiness unavailable')
   subprocess.run(['systemd-run','--user','--unit=vivid-computer-driver','--service-type=exec','--collect',
    *['--setenv='+name+'='+env[name] for name in required],str(binary),'serve','--socket',str(endpoint),
    '--permission-mode','standard','--grant','existing-profile','--no-overlay'],
    env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   deadline=time.monotonic()+10
   while not endpoint.exists():
    remaining=max(0,deadline-time.monotonic())
    if not select.select([watch],[],[],remaining)[0]: raise RuntimeError('driver readiness expired')
    os.read(watch,65536)
  finally: os.close(watch)
 generation=subprocess.check_output(['systemctl','--user','show','vivid-computer-driver','--property=InvocationID','--value'],env=env,text=True).strip()
 if not re.fullmatch('[0-9a-f]{32}',generation): raise RuntimeError('driver generation absent')
print(json.dumps({'socket':str(endpoint),'binary':str(binary),'generation':generation}))
VIVID_DRIVER`
const Endpoint = Schema.Struct({
  binary: Schema.String.check(
    Schema.isPattern(/^\/home\/[a-z_][a-z0-9_-]*\/\.local\/share\/vivid\/computer\/driver$/),
  ),
  generation: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  socket: Schema.String.check(Schema.isPattern(/^\/run\/user\/[0-9]+\/vivid-driver\.sock$/)),
})
const decodeEndpoint = Schema.decodeUnknownEffect(Schema.fromJsonString(Endpoint))

/** Guest setup has a bounded receipt and exposes only the private socket path to this adapter. */
export const guestDriver = Effect.fn('Machine.boat.guest.driver')(function* (
  api: Transport,
  id: ProviderId,
  key: MachineKey,
) {
  const receipt = yield* api.command(id, key, guestCommand, 180)
  if (receipt.exitCode !== 0 || receipt.timedOut)
    return yield* new MachineOperationFailed({ operation: 'desktop-session' })
  if (receipt.stdoutTruncated === true)
    return yield* new MachineResponseInvalid({ operation: 'desktop-session' })
  const endpoint = yield* decodeEndpoint(receipt.stdout).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'desktop-session' })),
  )
  return { native: driver(api, id, key, endpoint), generation: endpoint.generation }
})

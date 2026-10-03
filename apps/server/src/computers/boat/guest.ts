import { Effect, Schema } from 'effect'
import { MachineOperationFailed, MachineResponseInvalid, type MachineKey } from '../machine.ts'
import { driver } from './driver.ts'
import type { ProviderId } from './protocol.ts'
import type { Transport } from './transport.ts'
import { Windows } from './browser.ts'

/** Boat's 0.23.2 daemon uses a different session bus from its X11 desktop. Its process-lifetime
 * AT-SPI connection cannot see Chrome's renderer tree (platform-linux/src/atspi/native.rs).
 * Resolve the desktop session from Cua's PID-attested desktop panel, then start the shipped
 * binary through its public serve API in that session. Preserve standard existing-profile
 * authorization; never restart Boat's daemon or relax its policy. The owned unit/socket live
 * under /run and are recreated after resume. Remove this workaround when Boat fixes its bus.
 * inotify proves socket readiness; the lock makes concurrent server processes share one unit. */
export const guestCommand = (pid: number) => String.raw`python3 - ${pid} <<'VIVID_DRIVER'
import ctypes as c, fcntl, json, os, pathlib, select, subprocess, sys, time
pid=int(sys.argv[1])
entries=pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
environment=dict(item.decode().split('=',1) for item in entries if b'=' in item)
required=['DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR']
if not all(environment.get(name) for name in required): raise RuntimeError('desktop session unavailable')
env=os.environ.copy(); env.update({name:environment[name] for name in required})
runtime=pathlib.Path(env['XDG_RUNTIME_DIR'])
endpoint=runtime/'vivid-driver.sock'
with (runtime/'vivid-driver.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 if not endpoint.exists():
  libc=c.CDLL(None,use_errno=True)
  watch=libc.inotify_init1(os.O_CLOEXEC)
  if watch < 0: raise RuntimeError('driver readiness unavailable')
  try:
   if libc.inotify_add_watch(watch,str(runtime).encode(),0x100|0x80) < 0: raise RuntimeError('driver readiness unavailable')
   subprocess.run(['systemd-run','--user','--unit=vivid-computer-driver','--service-type=exec','--collect',
    *['--setenv='+name+'='+env[name] for name in required],
    '/opt/ascii/cua-driver/cua-driver','serve','--socket',str(endpoint),
    '--permission-mode','standard','--grant','existing-profile','--no-overlay'],
    env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   deadline=time.monotonic()+10
   while not endpoint.exists():
    remaining=max(0,deadline-time.monotonic())
    if not select.select([watch],[],[],remaining)[0]: raise RuntimeError('driver readiness expired')
    os.read(watch,65536)
  finally: os.close(watch)
print(json.dumps({'socket':str(endpoint)}))
VIVID_DRIVER`
const Endpoint = Schema.Struct({
  socket: Schema.String.check(Schema.isPattern(/^\/run\/user\/[0-9]+\/vivid-driver\.sock$/)),
})
const decodeEndpoint = Schema.decodeUnknownEffect(Schema.fromJsonString(Endpoint))

/** Guest setup has a bounded receipt and exposes only the private socket path to this adapter. */
export const browserDriver = Effect.fn('Machine.boat.browser.driver')(function* (
  api: Transport,
  id: ProviderId,
  key: MachineKey,
) {
  const windows = yield* driver(api, id, key, '/run/ascii-cua/driver.sock').call(
    'list_windows',
    {},
    Windows,
  )
  const panels = new Set(
    windows.windows
      .filter((window) => window.app_name === 'AsciiDesktop')
      .map((window) => window.pid),
  )
  const [pid] = panels
  if (panels.size !== 1 || pid === undefined || pid === null)
    return yield* Effect.fail(new MachineOperationFailed({ operation: 'desktop-session' }))
  const receipt = yield* api.command(id, key, guestCommand(pid), 30)
  if (receipt.exitCode !== 0 || receipt.timedOut)
    return yield* Effect.fail(new MachineOperationFailed({ operation: 'desktop-session' }))
  if (receipt.stdoutTruncated === true)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'desktop-session' }))
  const endpoint = yield* decodeEndpoint(receipt.stdout).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'desktop-session' })),
  )
  return driver(api, id, key, endpoint.socket)
})

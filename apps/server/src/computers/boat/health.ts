import {
  ComputerProbe,
  ComputerProbeFailure as Failure,
  ComputerProbeObservation as Observation,
  ComputerProbeResult as ProbeResult,
  type ComputerRecoveryStep,
} from '@vivid/contracts'
import { Effect, Result, Schema, Option } from 'effect'
import {
  MachineRecovery,
  MachineExecutionUnknown,
  MachineAuthenticationFailed,
  MachineOperationFailed,
  BrowserStepFailed,
  MachineResponseInvalid,
  type MachineFailure,
  type MachineKey,
  type MachineOperations,
} from '../machine.ts'
import { probeFailure } from '../health.ts'
import { EGRESS_PROXY_ADDRESS } from '../egress/guest.ts'
import { desktopSession, DriverEndpoint, guestDriver } from './guest.ts'
import { driver, type Driver } from './driver.ts'
import { Windows, chrome, browserHealth } from './browser.ts'
import { ComputerToolRefused, ComputerActionRefused } from './refusal.ts'
import type { Transport } from './transport.ts'
import type { ProviderId } from './protocol.ts'

const Session = Schema.TaggedUnion({ Ready: DriverEndpoint.fields, Failed: {} })
const Guest = Schema.Struct({ probes: Schema.Array(ComputerProbe), session: Session })
const decodeGuest = Schema.decodeEffect(Schema.fromJsonString(Guest))
const decodeRecovery = Schema.decodeEffect(Schema.fromJsonString(MachineRecovery))
/** Passive probes install nothing, start nothing, and never read history, page content or secrets
 * into their receipt. The fixed network endpoint follows the selected egress without starting it. */
export const healthCommand = (egress: boolean) => String.raw`python3 - <<'VIVID_HEALTH'
import os,pathlib,json,subprocess,re,time,email.utils,urllib.request
probes=[]
def passed(component,observed): probes.append({'component':component,'result':{'_tag':'Passed','observed':observed}})
def failed(component,tag): probes.append({'component':component,'result':{'_tag':'Failed','failure':{'_tag':tag}}})
volumes=[]
for path,label in [('/','/'),(str(pathlib.Path.home()),'home')]:
 info=os.statvfs(path); volumes.append({'path':label,'availableBytes':info.f_bavail*info.f_frsize,'availableInodes':info.f_favail})
if any(v['availableBytes']==0 for v in volumes): failed('Disk','DiskFull')
elif any(v['availableInodes']==0 for v in volumes): failed('Disk','InodesFull')
else: passed('Disk',{'_tag':'Disk','volumes':volumes})
def session():
${desktopSession
  .split('\n')
  .map((line) => ' ' + line)
  .join('\n')}
 return env,runtime,endpoint
try:
 env,runtime,endpoint=session()
 subprocess.run(['xdpyinfo'],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
 subprocess.run(['busctl','--address='+env['DBUS_SESSION_BUS_ADDRESS'],'--no-pager','list'],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
 passed('Desktop',{'_tag':'Responsive'})
 binary=pathlib.Path.home()/'.local/share/vivid/computer/driver'
 generation=subprocess.check_output(['systemctl','--user','show','vivid-computer-driver','--property=InvocationID','--value'],env=env,text=True,timeout=5).strip()
 active=subprocess.run(['systemctl','--user','is-active','--quiet','vivid-computer-driver'],env=env,timeout=5).returncode==0
 if not active or not endpoint.is_socket() or not binary.is_file() or not re.fullmatch('[0-9a-f]{32}',generation):
  failed('Driver','DriverUnresponsive'); current={'_tag':'Failed'}
 else: current={'_tag':'Ready','socket':str(endpoint),'binary':str(binary),'generation':generation}
except Exception:
 failed('Desktop','DesktopSession'); current={'_tag':'Failed'}
 probes.append({'component':'Driver','result':{'_tag':'NotRun','reason':'UpstreamUnavailable'}})
try:
 start=time.time()
 proxy=${JSON.stringify(egress ? EGRESS_PROXY_ADDRESS : '')}
 client=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy} if proxy else {}))
 with client.open(urllib.request.Request('https://example.com',method='HEAD'),timeout=10) as response:
  remote=email.utils.parsedate_to_datetime(response.headers['Date']).timestamp()
 end=time.time()
 passed('Network',{'_tag':'Network','clockOffsetMillis':(remote-(start+end)/2)*1000,'uncertaintyMillis':(end-start)*500+1000})
except Exception: failed('Network','Network')
print(json.dumps({'probes':probes,'session':current}))
VIVID_HEALTH`

/** X11's exact window supplies the PID, then pidfd pins its generation before any signal.
 * Reopen the same executable, arguments, working directory and session environment. No profile,
 * lock, unrelated PID or cookie is deleted. An uncertain receipt never authorizes repetition. */
const restartBrowser = (window: {
  readonly pid: number
  readonly window_id: number
}) => String.raw`python3 - <<'VIVID_BROWSER_RECOVERY'
import os,pathlib,signal,select,subprocess,json,re
pid=${window.pid}
window=${window.window_id}
properties=subprocess.check_output(['xprop','-id',hex(window),'_NET_WM_PID'],text=True)
if not re.search(r'= '+str(pid)+r'\b',properties): raise RuntimeError('window ownership changed')
handle=os.pidfd_open(pid)
try:
 root=pathlib.Path('/proc')/str(pid)
 executable=root.joinpath('exe').resolve(strict=True)
 if executable.name not in ['chrome','chromium','google-chrome-stable']: raise RuntimeError('unattested browser')
 if root.stat().st_uid != os.getuid(): raise RuntimeError('browser owner changed')
 args=[item.decode() for item in root.joinpath('cmdline').read_bytes().split(b'\0') if item]
 env=dict(item.decode().split('=',1) for item in root.joinpath('environ').read_bytes().split(b'\0') if b'=' in item)
 cwd=str(root.joinpath('cwd').resolve(strict=True))
 if select.select([handle],[],[],0)[0]: raise RuntimeError('browser generation ended')
 signal.pidfd_send_signal(handle,signal.SIGTERM)
 if not select.select([handle],[],[],20)[0]: raise RuntimeError('browser did not stop')
 subprocess.Popen([str(executable),*args[1:]],env=env,cwd=cwd,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 print(json.dumps({'_tag':'Applied'}))
finally: os.close(handle)
VIVID_BROWSER_RECOVERY`

/** Only the X11-attested user supervisor unit can restart; InvocationID is compared inside the
 * unit's session before dispatch. A different generation refuses rather than stopping it. */
const restartDriver = (generation: string) => String.raw`python3 - <<'VIVID_DRIVER_RECOVERY'
${desktopSession}
fields=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','--user','show','vivid-computer-driver','--property=InvocationID','--property=MainPID'],env=env,text=True).splitlines())
if fields['InvocationID'] != '${generation}': raise RuntimeError('driver generation changed')
pid=int(fields['MainPID'])
if pid <= 0: raise RuntimeError('driver process absent')
handle=os.pidfd_open(pid)
try:
 binary=pathlib.Path.home()/'.local/share/vivid/computer/driver'
 if pathlib.Path(f'/proc/{pid}/exe').resolve(strict=True) != binary: raise RuntimeError('driver executable changed')
 actual=subprocess.check_output(['systemctl','--user','show','vivid-computer-driver','--property=InvocationID','--value'],env=env,text=True).strip()
 if actual != '${generation}' or select.select([handle],[],[],0)[0]: raise RuntimeError('driver generation changed')
 import signal
 signal.pidfd_send_signal(handle,signal.SIGTERM)
 if not select.select([handle],[],[],20)[0]: raise RuntimeError('driver did not stop')
finally: os.close(handle)
print(json.dumps({'_tag':'Applied'}))
VIVID_DRIVER_RECOVERY`

/** A failed upstream check prevents downstream calls; cached driver sessions retain the exact
 * profile grant. Passive reads never call guestDriver, browser_prepare or launch_app. */
interface HealthAuthority {
  readonly api: Transport
  readonly accepted: (key: MachineKey) => Effect.Effect<{ readonly id: ProviderId }, MachineFailure>
  readonly shell: Pick<MachineOperations, 'run'>
  readonly connections: { readonly forget: (key: MachineKey) => Effect.Effect<void> }
  readonly drivers: Map<MachineKey, { readonly native: Driver; readonly generation: string }>
  readonly forget: (key: MachineKey) => void
}

/** The session is attested before the driver is contacted; browser permission refusal cannot
 * be reclassified as a hung process and used to authorize a restart. */
const inspectBrowser = Effect.fn('Machine.boat.health.browser')(function* (
  input: HealthAuthority,
  request: {
    readonly key: MachineKey
    readonly session: typeof Session.cases.Ready.Type
    readonly id: ProviderId
    readonly probes: ReadonlyArray<ComputerProbe>
  },
) {
  const { session, id } = request
  const probes = Array.from(request.probes)
  const prior = input.drivers.get(request.key)
  const native =
    prior !== undefined && prior.generation === session.generation
      ? prior.native
      : driver(input.api, id, request.key, session)
  input.drivers.set(request.key, { native, generation: session.generation })
  const responsive = yield* native.call('list_windows', {}, Windows).pipe(Effect.result)
  if (Result.isFailure(responsive))
    return [
      ...probes,
      ComputerProbe.make({
        component: 'Driver',
        result: ProbeResult.cases.Failed.make({
          failure: Failure.cases.DriverUnresponsive.make({}),
        }),
      }),
      ComputerProbe.make({
        component: 'Browser',
        result: ProbeResult.cases.NotRun.make({ reason: 'UpstreamUnavailable' }),
      }),
    ]
  input.drivers.set(request.key, { native, generation: session.generation })
  probes.push(
    ComputerProbe.make({
      component: 'Driver',
      result: ProbeResult.cases.Passed.make({ observed: Observation.cases.Responsive.make({}) }),
    }),
  )
  const windows = responsive.success.windows.filter((window) =>
    /chrome|chromium/i.test(window.app_name),
  )
  if (windows.length === 0)
    return [
      ...probes,
      ComputerProbe.make({
        component: 'Browser',
        result: ProbeResult.cases.NotRun.make({ reason: 'BrowserNotStarted' }),
      }),
    ]
  if (windows.length !== 1)
    return [
      ...probes,
      ComputerProbe.make({
        component: 'Browser',
        result: ProbeResult.cases.Failed.make({ failure: Failure.cases.BrowserAmbiguous.make({}) }),
      }),
    ]
  const browser = yield* browserHealth(native).pipe(Effect.result)
  probes.push(
    ComputerProbe.make({
      component: 'Browser',
      result: Result.isSuccess(browser)
        ? ProbeResult.cases.Passed.make({ observed: Observation.cases.Responsive.make({}) })
        : ProbeResult.cases.Failed.make({ failure: browserFailure(browser.failure) }),
    }),
  )
  return probes
})

/** Permission, selection and protocol refusals cannot authorize killing a browser. Only an
 * operation failure after a responsive driver is evidence of browser unresponsiveness. */
function browserFailure(failure: MachineFailure) {
  if (failure instanceof ComputerToolRefused || failure instanceof ComputerActionRefused)
    return Failure.cases.BrowserPermission.make({})
  if (failure instanceof BrowserStepFailed) return Failure.cases.BrowserAmbiguous.make({})
  if (failure instanceof MachineOperationFailed) return Failure.cases.BrowserUnresponsive.make({})
  return probeFailure(failure)
}

/** The provider exposes passive diagnosis and one closed mutation operation over its authority. */
export function machineHealth(input: HealthAuthority) {
  return { health: health(input), recover: recovery(input) }
}

/** A failed SSH receipt leaves every downstream probe explicitly NotRun. */
const health = (input: HealthAuthority) =>
  Effect.fn('Machine.boat.health')(function* (request: {
    readonly key: MachineKey
    readonly egress: boolean
  }) {
    const ssh = yield* input.shell
      .run({ key: request.key, command: 'true', directory: '.', timeoutSeconds: 10 })
      .pipe(Effect.result)
    if (Result.isFailure(ssh)) return unavailableSsh(ssh.failure)
    if (ssh.success.exitCode !== 0 || ssh.success.timedOut)
      return unavailableSsh(new MachineResponseInvalid({ operation: 'ssh-probe' }))
    const identity = yield* input.accepted(request.key)
    const receipt = yield* input.shell.run({
      key: request.key,
      command: healthCommand(request.egress),
      directory: '.',
      timeoutSeconds: 45,
    })
    if (receipt.exitCode !== 0 || receipt.timedOut || receipt.truncated)
      return yield* new MachineResponseInvalid({ operation: 'health-probes' })
    const guest = yield* decodeGuest(receipt.stdout).pipe(
      Effect.mapError(() => new MachineResponseInvalid({ operation: 'health-probes' })),
    )
    const probes: ComputerProbe[] = [
      ComputerProbe.make({
        component: 'Ssh',
        result: ProbeResult.cases.Passed.make({ observed: Observation.cases.Responsive.make({}) }),
      }),
      ...guest.probes,
    ]
    if (Session.guards.Failed(guest.session))
      return [
        ...probes,
        ComputerProbe.make({
          component: 'Browser',
          result: ProbeResult.cases.NotRun.make({ reason: 'UpstreamUnavailable' }),
        }),
      ]
    return yield* inspectBrowser(input, {
      key: request.key,
      session: guest.session,
      id: identity.id,
      probes,
    })
  })

/** The transport failure is never confused with provider lifecycle, and no downstream command
 * runs until the harmless SSH receipt proves that the guest can answer. */
function unavailableSsh(failure: MachineFailure): ReadonlyArray<ComputerProbe> {
  const cause =
    failure instanceof MachineAuthenticationFailed
      ? Failure.cases.SshAuthentication.make({})
      : failure instanceof MachineResponseInvalid
        ? Failure.cases.SshHostMismatch.make({})
        : Failure.cases.SshUnreachable.make({})
  return [
    ComputerProbe.make({
      component: 'Ssh',
      result: ProbeResult.cases.Failed.make({ failure: cause }),
    }),
    ...(['Disk', 'Desktop', 'Driver', 'Browser', 'Network'] as const).map((component) =>
      ComputerProbe.make({
        component,
        result: ProbeResult.cases.NotRun.make({ reason: 'UpstreamUnavailable' }),
      }),
    ),
  ]
}

/** Recovery chooses a command only for the diagnosed component with its prerequisites met. */
const recoveryCommand = Effect.fn('Machine.boat.recovery.command')(function* (
  request: Parameters<MachineOperations['recover']>[0],
  current: Effect.Success<ReturnType<typeof guestDriver>>,
) {
  const failed = request.probes.filter((probe) => ProbeResult.guards.Failed(probe.result))
  if (request.step === 'RestartDriver' && failed.some((probe) => probe.component === 'Driver'))
    return Option.some(restartDriver(current.generation))
  else if (
    request.step === 'RestartBrowser' &&
    request.probes
      .filter((probe) => ['Ssh', 'Disk', 'Desktop', 'Driver'].includes(probe.component))
      .every((probe) => ProbeResult.guards.Passed(probe.result)) &&
    failed.some(
      (probe) =>
        ProbeResult.guards.Failed(probe.result) &&
        Failure.guards.BrowserUnresponsive(probe.result.failure),
    )
  )
    return Option.some(restartBrowser(yield* chrome(current.native, false, Effect.succeedNone)))
  return Option.none()
})

/** Dispatch one supported supervisor action only for its diagnosed component. */
const recovery = (input: HealthAuthority) =>
  Effect.fn('Machine.boat.recover')(function* (request: {
    readonly key: MachineKey
    readonly step: ComputerRecoveryStep
    readonly probes: ReadonlyArray<ComputerProbe>
  }) {
    const failed = request.probes.filter((probe) => ProbeResult.guards.Failed(probe.result))
    if (request.step === 'Reconnect' && failed.some((probe) => probe.component === 'Ssh')) {
      input.forget(request.key)
      yield* input.connections.forget(request.key)
      return MachineRecovery.cases.Applied.make({})
    }
    const current = input.drivers.get(request.key)
    if (current === undefined)
      return MachineRecovery.cases.Unsupported.make({
        reason: 'No attested owned driver generation is available.',
      })
    const command = yield* recoveryCommand(request, current)
    if (Option.isNone(command)) return MachineRecovery.cases.Refused.make({})
    const receipt = yield* input.shell.run({
      key: request.key,
      command: command.value,
      directory: '.',
      timeoutSeconds: 45,
    })
    input.forget(request.key)
    if (receipt.exitCode !== 0 || receipt.timedOut || receipt.truncated)
      return yield* new MachineExecutionUnknown({ key: request.key })
    const outcome = yield* decodeRecovery(receipt.stdout).pipe(
      Effect.mapError(() => new MachineExecutionUnknown({ key: request.key })),
    )
    if (request.step === 'RestartDriver' && MachineRecovery.guards.Applied(outcome)) {
      const identity = yield* input.accepted(request.key)
      const renewed = yield* guestDriver(input.api, identity.id, request.key)
      input.drivers.set(request.key, renewed)
    }
    if (request.step === 'RestartBrowser' && MachineRecovery.guards.Applied(outcome)) {
      // A spawned process is not a browser receipt. Require the same profile's semantic read
      // before reporting completion; an unopened browser must not become a false Ready result.
      yield* browserHealth(current.native)
      input.drivers.set(request.key, current)
    }
    return outcome
  })

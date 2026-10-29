import * as NodeChildProcess from 'node:child_process'
import * as NodeUtil from 'node:util'
import { alive } from './process.mjs'
import { Device } from './phonewire.mjs'

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)

/** The devbox provisioner binds its private adb server to 15037; the PC attaches to its own. */
export const adbPort = (device) =>
  Device.match(device, { devbox: () => '15037', pc: (pc) => String(pc.adbPort) })

/** A devbox emulator is alive while its captured generation is. A Windows emulator has no Linux
 * PID, so the PC asks adb: the serial answers and Android still reports boot completed. adb
 * reads against a vanished guest can wait indefinitely; the bound turns that into "gone". */
export async function reachable(device) {
  return Device.match(device, {
    devbox: (devbox) => alive(devbox.emulator),
    pc: async (pc) => {
      try {
        const { stdout } = await execFile(
          'timeout',
          [
            '20',
            pc.sdk + '/platform-tools/adb',
            '-s',
            pc.serial,
            'shell',
            'getprop',
            'sys.boot_completed',
          ],
          { env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(pc.adbPort) } },
        )
        return stdout.trim() === '1'
      } catch {
        return false
      }
    },
  })
}

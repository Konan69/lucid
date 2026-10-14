import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { MachineKey, MachineOperations } from '../machine.ts'

/**
 * The egress proxy on a Computer (`proxy.mjs`): where it listens, and how it is put there and
 * started.
 *
 * The two ports are Grok Bot's own for the same two jobs (`ea2-window-lifecycle.ts`, the port
 * table: `egressTunnelWebSocket: 8790`, `egressConnectProxy: 8791`). Both are on the Computer's
 * loopback only: the browser reaches the proxy there, and the server reaches the tunnel port
 * through its SSH connection (`ssh/link.ts`, `tunnel`), so the Computer opens nothing to the
 * network for this.
 */
export const EGRESS_TUNNEL_PORT = 8790
export const EGRESS_PROXY_PORT = 8791

/** What the Computer's browser is told its proxy is. */
export const EGRESS_PROXY_ADDRESS = `http://127.0.0.1:${EGRESS_PROXY_PORT}`

/** The line that ends the proxy's text inside the start command. It is not a line of that text. */
const END_OF_TEXT = 'VIVID_EGRESS_PROXY_TEXT'

/**
 * The command that makes sure the proxy is running on a Computer. Every word of it is the
 * server's own. It may be run any number of times:
 *
 * - The file's name carries the hash of its text (as the program runner's does,
 *   `code/computer.ts`), and it is written only when it is not there, through a temporary file
 *   named for the shell that writes it. Two runs at the same moment (a browser step and a join
 *   both make sure of the proxy) once shared one temporary name: the first moved it into place
 *   and the second, finding it gone, failed. Each now moves its own whole copy.
 * - The proxy records its own process id when it starts. When the process with that id is this
 *   same file and the proxy port answers, nothing is done.
 * - When the recorded process is an older text of Vivid's proxy, that one process is ended, by
 *   the id it recorded itself and only after its command line is seen to be that program. No
 *   process is ever looked for by name.
 * - A second copy started beside a running one ends by itself: the ports are taken.
 *
 * It answers 0 once the proxy port takes a connection, and 1 when it has not within five
 * seconds. `setsid` takes the proxy out of the command's process group, so it outlives the
 * command and the SSH connection that ran it: the browser's proxy must not vanish when the
 * server restarts.
 */
export const startCommand = (
  text: string,
  ports: { readonly tunnel: number; readonly proxy: number },
): string => {
  const hash = NodeCrypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  return [
    'dir="$HOME/.local/share/vivid/computer"',
    `file="$dir/egress-${hash}.mjs"`,
    'pid="$dir/egress.pid"',
    `listening() { (exec 3<>/dev/tcp/127.0.0.1/${ports.proxy}) 2>/dev/null; }`,
    'recorded() { [ -f "$pid" ] && tr "\\0" " " < "/proc/$(cat "$pid")/cmdline" 2>/dev/null | grep -qF -- "$1"; }',
    'mkdir -p "$dir" || exit 1',
    `[ -f "$file" ] || { cat > "$file.$$.new" <<'${END_OF_TEXT}' && mv "$file.$$.new" "$file" || exit 1; }`,
    text,
    END_OF_TEXT,
    'if recorded "$file" && listening; then exit 0; fi',
    'if recorded "$dir/egress-"; then kill "$(cat "$pid")"; for _ in $(seq 20); do listening || break; sleep 0.1; done; fi',
    `setsid nohup node "$file" ${ports.tunnel} ${ports.proxy} "$pid" > /dev/null 2>&1 < /dev/null &`,
    'for _ in $(seq 50); do listening && exit 0; sleep 0.1; done',
    'exit 1',
  ].join('\n')
}

/** The proxy's text, or nothing when it is not beside this module: a server built without it. */
export const readProxy = Effect.sync(() =>
  Option.liftThrowable(() =>
    NodeFS.readFileSync(new URL('./proxy.mjs', import.meta.url), 'utf8'),
  )(),
)

/**
 * Makes sure the egress proxy is running on a Computer that is already awake, and answers
 * whether it is. It never wakes a Computer and never fails: egress is a way out the browser may
 * use, not a condition of browsing, so every caller treats "not running" as "go out directly".
 */
export const startProxy = Effect.fn('Egress.startProxy')(function* (
  machine: Pick<MachineOperations, 'run'>,
  key: MachineKey,
) {
  const text = yield* readProxy
  if (Option.isNone(text)) {
    yield* Effect.logError('The egress proxy text is missing from this server.')
    return false
  }
  return yield* machine
    .run({
      key,
      command: startCommand(text.value, { tunnel: EGRESS_TUNNEL_PORT, proxy: EGRESS_PROXY_PORT }),
      directory: '/',
      timeoutSeconds: 20,
    })
    .pipe(
      Effect.map((run) => run.exitCode === 0),
      Effect.catch((failure) =>
        Effect.logWarning('The egress proxy could not be started.', failure._tag).pipe(
          Effect.as(false),
        ),
      ),
    )
})

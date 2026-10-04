import * as NodeHttp from 'node:http'
import * as NodeHttps from 'node:https'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The longest an idle connection to the application server may wait for its next request.
 *
 * Node only honours the server's `Keep-Alive: timeout=N` hint when it is shorter than the agent's
 * own timeout (`Agent.prototype.keepSocketAlive`, node `lib/_http_agent.js`), so the agent needs
 * one for the hint to count at all. With it, Node drops an idle connection a second before the
 * server said it would close it (`agentKeepAliveTimeoutBuffer`). That buffer makes it less likely
 * that a new request is written to a connection the server is closing; it does not remove the
 * race. For a connection that is carrying a request, Node's handler for this timeout only emits
 * an event (`installListeners` destroys free sockets only), so this timeout is not what ends a
 * long upload or stream.
 */
const IDLE_CONNECTION_MILLISECONDS = 60_000

/**
 * Builds the agent that carries proxied requests to the application server.
 *
 * Vite's proxy sets `Connection: close` on every request it forwards when it has no agent
 * (`setupOutgoing` in vite `dist/node/chunks/node.js`: `outgoing.agent = options.agent || false`),
 * which makes the server close the connection after each answer. A keep-alive agent leaves the
 * header alone. That is all the agent does: it removes the close Vite forced. It does not make an
 * early answer from the server (a 413 sent while the body is still arriving) reach the browser;
 * that still fails there, and the fix belongs to the server's response handling.
 *
 * `target` is the server's HTTP base address, so its protocol is `http:` or `https:`. The proxy's
 * HTTP pass picks its module with `target.protocol === "https:"` (`stream` in the same file) and
 * the agent has to come from that module, so this uses the same test. The WebSocket pass tests
 * `/^https|wss/`, which gives the same module for both of those protocols.
 */
const upstreamAgent = (target: string) => {
  const options = { keepAlive: true, timeout: IDLE_CONNECTION_MILLISECONDS }
  return new URL(target).protocol === 'https:'
    ? new NodeHttps.Agent(options)
    : new NodeHttp.Agent(options)
}

/**
 * Closes the agent's connections with the server that owns it. `closeServer` covers the dev
 * server on close and on restart; a restart evaluates this config again, which builds a new agent
 * before the old server is closed. `closePreviewServer` is the same for `vite preview`. Upgraded
 * WebSockets have already left the agent's pool (`agentRemove`), so this does not touch them.
 */
const releaseUpstream = (agent: NodeHttp.Agent): Plugin => ({
  name: 'vivid:upstream',
  closeServer: () => agent.destroy(),
  closePreviewServer: () => agent.destroy(),
})

/**
 * Development is single-origin: the browser only ever talks to this dev server, which forwards
 * everything under `/api` to the application server. That one rule carries the product calls, the
 * live WebSocket, Better Auth, the conversation gateway and the Computer's screen, so cookies are
 * same-origin and no service address or token is ever compiled into the bundle.
 *
 * `xfwd` passes the address the browser used, so the server can hand back stream addresses that
 * are right for whoever is asking (a phone on the local network reaches this by another name).
 */
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VIVID_')
  const server = environment.VIVID_SERVER_URL ?? 'http://127.0.0.1:8787'
  const agent = upstreamAgent(server)
  // `/health` goes through too: the desktop app checks it before it trusts an address, and the
  // address a Person gives it is this one, the same origin the server is told to trust. Without it
  // the only address that passed the check was the server's own port, whose origin sign-in refuses.
  const proxy = {
    '/api': { target: server, ws: true, xfwd: true, agent },
    '/health': { target: server, xfwd: true, agent },
  }

  return {
    plugins: [react(), tailwindcss(), releaseUpstream(agent)],
    // The design-system components import each other as `@/ui/...` (the alias `components.json`
    // gives the shadcn CLI), so Vite resolves the same `paths` the type checker reads.
    resolve: { tsconfigPaths: true },
    preview: { port: 4178, host: '127.0.0.1', proxy, allowedHosts: ['.trycloudflare.com'] },
    server: { port: 5178, proxy },
  }
})

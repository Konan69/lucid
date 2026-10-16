import * as NodeHttp from 'node:http'
import * as NodeHttps from 'node:https'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { index, rootRoute, route } from '@tanstack/virtual-file-routes'
import manifest from './package.json' with { type: 'json' }

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

  // Which build an error report names (`src/data/telemetry.ts`): the app's version, then the
  // commit when the build is given one. `VIVID_COMMIT` is the name the server already reads its
  // own commit from (`apps/server/src/config.ts`); a build without it reports the version alone.
  const commit = environment.VIVID_COMMIT
  const release =
    commit === undefined || commit === ''
      ? `vivid-web@${manifest.version}`
      : `vivid-web@${manifest.version}+${commit.slice(0, 12)}`

  // Source maps for Sentry (`src/data/telemetry.ts`). The build emits them hidden (`build.
  // sourcemap` below): each bundle ships beside its map, but no comment in the bundle names the
  // map, so a browser never learns where the sources are. The plugin stamps a debug ID into both
  // the bundle and the map inside the build pipeline and uploads the maps to Sentry; matching
  // happens by that ID, not by the release name, so this is independent of the release string
  // above. Without `SENTRY_AUTH_TOKEN` the plugin is left out and the maps are still written, so
  // a build with no credentials behaves the same otherwise. The upload needs the token only for
  // `project:write` on `vivid-web`.
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN

  return {
    // Which build this page is, as Settings says it (`src/data/build.ts`): the commit, empty when
    // the build was given none, and the moment this config was read, which is when the build ran.
    define: {
      __VIVID_RELEASE__: JSON.stringify(release),
      __VIVID_COMMIT__: JSON.stringify(commit === undefined ? '' : commit),
      __VIVID_BUILT__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      // The route tree (`src/tree.gen.ts`) is generated from this list, before React's plugin
      // sees the files. The list is written out, not read from file names: the router's own
      // naming (`__root.tsx`, `t.$id.tsx`) is not one word per file, and here each address
      // names the file that defines it (`docs/00-structure.md`). No `autoCodeSplitting`: each
      // route names its screen's file itself (`src/routes/root.tsx` says why).
      tanstackRouter({
        target: 'react',
        routesDirectory: './src/routes',
        generatedRouteTree: './src/tree.gen.ts',
        virtualRouteConfig: rootRoute('root.tsx', [
          index('first.tsx'),
          route('/t/$id', 'thread.tsx'),
          route('/library', 'library.tsx'),
          route('/projects/{-$id}', 'projects.tsx'),
          route('/invite/$id', 'invite.tsx'),
        ]),
      }),
      react(),
      tailwindcss(),
      releaseUpstream(agent),
      ...(sentryAuthToken === undefined
        ? []
        : [
            sentryVitePlugin({
              org: 'vivid-7t',
              project: 'vivid-web',
              authToken: sentryAuthToken,
            }),
          ]),
    ],
    // The design-system components import each other as `@/ui/...` (the alias `components.json`
    // gives the shadcn CLI), so Vite resolves the same `paths` the type checker reads.
    resolve: { tsconfigPaths: true },
    // Two documents: the app, and the small notice the desktop app shows on the Person's screen
    // while Vivid works in their apps (`src/notice.tsx`). The notice is its own entry so that
    // window loads the face and the tokens without loading the app.
    build: {
      rollupOptions: { input: { main: 'index.html', notice: 'notice.html' } },
      // Hidden maps keep the sources private while still carrying the debug ID the plugin
      // injects (the plugin writes the ID into both files inside the bundler pipeline, so the
      // missing comment does not matter; matching happens by debug ID).
      sourcemap: 'hidden',
    },
    preview: { port: 4178, host: '127.0.0.1', proxy, allowedHosts: ['.trycloudflare.com'] },
    server: { port: 5178, proxy },
  }
})

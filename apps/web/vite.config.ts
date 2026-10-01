import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
  const proxy = { '/api': { target: server, ws: true, xfwd: true } }

  return {
    plugins: [react(), tailwindcss()],
    // Two entries: the app, and the lean page the phone loads over the tunnel.
    build: { rollupOptions: { input: { app: 'index.html', phone: 'phone.html' } } },
    preview: { port: 4178, host: '127.0.0.1', proxy, allowedHosts: ['.trycloudflare.com'] },
    server: { port: 5178, proxy },
  }
})

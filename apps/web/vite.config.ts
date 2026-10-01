import * as NodeURL from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const runtimeDirectory = NodeURL.fileURLToPath(
  new URL('../../packages/agent/runtime', import.meta.url),
)

export default defineConfig(({ mode }) => {
  const runtimeEnvironment = loadEnv(mode, runtimeDirectory, '')
  const runtimeToken = runtimeEnvironment.VIVID_RUNTIME_TOKEN

  const api = {
    '/api/rpc': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    '/api/ring': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    '/api/recordings': { target: 'http://127.0.0.1:8787', changeOrigin: true },
  }

  return {
    plugins: [react(), tailwindcss()],
    /**
     * The phone joins over a Cloudflare tunnel, where the dev server's hundreds of unbundled
     * modules are painfully slow. `pnpm preview` serves the built bundle instead, with the same
     * API proxy, so the phone gets one small download.
     */
    // Two entries: the app, and the lean page the phone loads over the tunnel.
    build: { rollupOptions: { input: { app: 'index.html', phone: 'phone.html' } } },
    preview: {
      port: 4178,
      host: '127.0.0.1',
      proxy: api,
      allowedHosts: ['.trycloudflare.com'],
    },
    server: {
      port: 5178,
      proxy: {
        '/api/rpc': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
        '/api/ring': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
        '/api/recordings': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
        ...Object.fromEntries(
          [
            '/api/library',
            '/api/routines',
            '/api/conversations',
            '/api/tasks',
            '/api/follow-ups',
            '/api/notifications',
          ].map((path) => [
            path,
            {
              target: runtimeEnvironment.VIVID_RUNTIME_URL ?? 'http://127.0.0.1:5173',
              changeOrigin: true,
              headers: runtimeToken ? { authorization: `Bearer ${runtimeToken}` } : undefined,
            },
          ]),
        ),
        '/api/vivid': {
          target: runtimeEnvironment.VIVID_RUNTIME_URL ?? 'http://127.0.0.1:5173',
          changeOrigin: true,
          headers: runtimeToken ? { authorization: `Bearer ${runtimeToken}` } : undefined,
          rewrite: (path) => path.replace(/^\/api\/vivid/, '/agents/vivid'),
        },
        '/api/connectors': {
          target: runtimeEnvironment.VIVID_RUNTIME_URL ?? 'http://127.0.0.1:5173',
          changeOrigin: true,
          headers: runtimeToken ? { authorization: `Bearer ${runtimeToken}` } : undefined,
        },
      },
    },
  }
})

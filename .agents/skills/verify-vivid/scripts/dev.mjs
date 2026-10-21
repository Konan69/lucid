import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeFSP from 'node:fs/promises'
const [role, scratch, port] = process.argv.slice(2)
const project = process.cwd()
const require = NodeModule.createRequire(NodePath.join(project, 'package.json'))
const vite = await import(require.resolve('vite'))

/** Public Vite createServer/listen use the shipped web configuration with isolated caches.
 * apps/web/vite.config.ts also calls loadEnv(mode, process.cwd(), 'VIVID_') directly, outside
 * Vite's envDir option. An empty owned cwd isolates that call; explicit root keeps all actual
 * web source, manifest, plugins and tsconfig resolution on main's unchanged configuration.
 * No SDK internals or application files are patched. */
const environment = NodePath.join(scratch, 'web-env')
await NodeFSP.mkdir(environment, { recursive: true })
process.chdir(environment)
const server = await vite.createServer({
  root: project,
  configFile: NodePath.join(project, 'vite.config.ts'),
  envDir: false,
  cacheDir: NodePath.join(scratch, role + '-cache'),
  server: { host: '127.0.0.1', port: Number(port), strictPort: true },
})
await server.listen()
process.send({ _tag: 'Ready', role })
process.on('SIGTERM', async () => {
  await server.close()
  process.exit(0)
})

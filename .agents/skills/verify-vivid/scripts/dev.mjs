import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeFSP from 'node:fs/promises'
const [role, scratch, port] = process.argv.slice(2)
const project = process.cwd()
const require = NodeModule.createRequire(NodePath.join(project, 'package.json'))
const vite = await import(require.resolve('vite'))

/** Use the shipped build and preview configuration, with all output under disposable scratch.
 * A cold dev graph serves thousands of modules and can time out before the first browser paint.
 * The config also calls loadEnv against cwd; an empty owned cwd isolates that explicit read.
 * Explicit root retains the actual source, plugins and tsconfig. No frontend source is patched. */
const environment = NodePath.join(scratch, 'web-env')
await NodeFSP.mkdir(environment, { recursive: true })
process.chdir(environment)
const config = {
  root: project,
  configFile: NodePath.join(project, 'vite.config.ts'),
  envDir: false,
  cacheDir: NodePath.join(scratch, 'web-cache'),
  build: { outDir: NodePath.join(scratch, 'web-dist'), emptyOutDir: true },
}
if (role === 'build') await vite.build(config)
else {
  const server = await vite.preview({
    ...config,
    preview: { host: '127.0.0.1', port: Number(port), strictPort: true },
  })
  process.send({ _tag: 'Ready', role })
  process.on('SIGTERM', async () => {
    await server.close()
    process.exit(0)
  })
}

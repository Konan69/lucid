import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodeCrypto from 'node:crypto'
import * as NodeModule from 'node:module'
import { command, root, json } from './process.mjs'
import { readApk, required } from './phonewire.mjs'

export const phoneOrigin = 'http://127.0.0.1:19278'
const cache = NodeOS.homedir() + '/.cache/vivid-android'
const sdk = NodeOS.homedir() + '/android_sdk'
export const phoneEnvironment = {
  ...process.env,
  PATH:
    cache +
    '/node/bin:' +
    cache +
    '/tools/node_modules/.bin:' +
    sdk +
    '/platform-tools:' +
    process.env.PATH,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ANDROID_ADB_SERVER_PORT: '15037',
  VIVID_SERVER: phoneOrigin,
  EXPO_NO_TYPESCRIPT_SETUP: '1',
  CI: '1',
}
const pnpm = [cache + '/node/bin/node', cache + '/tools/node_modules/pnpm/bin/pnpm.mjs']

/** Hash actual APK bytes, so reuse never trusts a filename or stale marker alone. */
export async function apkHash(file) {
  return NodeCrypto.createHash('sha256')
    .update(await NodeFSP.readFile(file))
    .digest('hex')
}

/** Native reuse requires identical dependency, config, asset and plugin inputs. TS/JS may repack.
 * The source checkout is private: Expo prebuild never writes to the proof's product checkout. */
async function inputs(head) {
  const tree = await command(['git', 'ls-tree', '-r', head])
  const lines = tree.split('\n').filter((line) => {
    const path = line.split('\t')[1]
    if (/package.json$|pnpm-lock.yaml$|pnpm-workspace.yaml$|^patches\//u.test(path)) return true
    if (!path.startsWith('apps/mobile/')) return false
    return !/^apps\/mobile\/(src\/|index\.ts$)/u.test(path) || !/\.(tsx?|jsx?)$/u.test(path)
  })
  return NodeCrypto.createHash('sha256')
    .update(lines.join('\n') + phoneOrigin)
    .digest('hex')
}

/** Content-addressed native builds survive runs; only a matching byte receipt permits reuse. */
export async function apk(state) {
  const directory = cache + '/apks'
  await NodeFSP.mkdir(directory, { recursive: true })
  const fingerprint = await inputs(state.head)
  const target = directory + '/' + state.head + '.apk'
  const receipt = target + '.json'
  const text = await NodeFSP.readFile(receipt, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text !== null) {
    const prior = required(readApk(text))
    if (prior.fingerprint === fingerprint && prior.sha256 === (await apkHash(target)))
      return { ...prior, mode: 'reuse' }
    throw new Error('APK cache receipt mismatch; retain evidence and inspect the cached artifact')
  }
  const source = cache + '/source'
  const present = await NodeFSP.stat(source + '/.git').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (present === null) await command(['git', 'clone', '--shared', '--no-checkout', root, source])
  await command(['git', 'fetch', 'origin', state.head], { cwd: source })
  await command(['git', 'checkout', '--detach', state.head], { cwd: source })
  const run = (args, name, cwd = source) =>
    command(args, {
      cwd,
      env: phoneEnvironment,
      log: state.evidence + '/apk-' + name + '.json',
    })
  await run([...pnpm, 'install', '--frozen-lockfile', '--filter', '@vivid/mobile...'], 'install')
  const app = source + '/apps/mobile'
  const native = directory + '/' + fingerprint + '.json'
  const base = await NodeFSP.readFile(native, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  let mode
  if (base !== null) {
    const artifact = required(readApk(base))
    if ((await apkHash(artifact.file)) !== artifact.sha256)
      throw new Error('Native APK checksum mismatch')
    await repack(run, app, artifact, target)
    mode = 'repack'
  } else {
    await NodeFSP.rm(app + '/android', { recursive: true, force: true })
    // native.mjs pins the template to the shipped SDK and prebuilds only if Android is absent.
    await run(['node', 'scripts/native.mjs', 'android', '--prebuild-only'], 'prebuild', app)
    await NodeFSP.writeFile(app + '/android/local.properties', 'sdk.dir=' + sdk + '\n')
    await run(
      [
        './gradlew',
        'assembleRelease',
        '--max-workers=2',
        '--no-daemon',
        '-PreactNativeArchitectures=x86_64',
        '-Pkotlin.compiler.execution.strategy=in-process',
        '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1536m',
      ],
      'gradle',
      app + '/android',
    )
    await NodeFSP.copyFile(app + '/android/app/build/outputs/apk/release/app-release.apk', target)
    await NodeFSP.copyFile(
      app + '/android/app/debug.keystore',
      directory + '/' + fingerprint + '.keystore',
    )
    mode = 'build'
  }
  const result = {
    head: state.head,
    fingerprint,
    file: target,
    sha256: await apkHash(target),
    origin: phoneOrigin,
    mode,
  }
  await json(receipt, result)
  if (mode === 'build') await json(native, result)
  return result
}

/** Bundle-only repacking is permitted only for an identical native/asset fingerprint. Expo's
 * embed export produces JS; the shipped hermesc compiles it as Gradle's React task does. */
async function repack(run, app, base, target) {
  const directory = cache + '/bundle'
  await NodeFSP.mkdir(directory, { recursive: true })
  const bundle = directory + '/index.android.bundle'
  await run(
    [
      ...pnpm,
      'exec',
      'expo',
      'export:embed',
      '--platform',
      'android',
      '--dev',
      'false',
      '--entry-file',
      'index.ts',
      '--bundle-output',
      bundle,
      '--max-workers',
      '2',
    ],
    'bundle',
    app,
  )
  const react = NodeModule.createRequire(app + '/node_modules/react-native/package.json')
  const hermes = react.resolve('hermes-compiler/hermesc/linux64-bin/hermesc')
  await run([hermes, '-O', '-emit-binary', '-out', bundle + '.hbc', bundle], 'hermes', app)
  await run(
    [
      'python3',
      '-c',
      `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[3],'w') as dst:
 for entry in src.infolist():
  if entry.filename.startswith('META-INF/') or entry.filename == 'assets/index.android.bundle': continue
  dst.writestr(entry,src.read(entry.filename))
 dst.write(sys.argv[2], 'assets/index.android.bundle')`,
      base.file,
      bundle + '.hbc',
      target,
    ],
    'zip',
    app,
  )
  const aligned = target + '.aligned'
  await run([sdk + '/build-tools/36.0.0/zipalign', '-f', '-p', '4', target, aligned], 'align', app)
  await NodeFSP.rename(aligned, target)
  await run(
    [
      sdk + '/build-tools/36.0.0/apksigner',
      'sign',
      '--ks',
      cache + '/apks/' + base.fingerprint + '.keystore',
      '--ks-pass',
      'pass:android',
      '--key-pass',
      'pass:android',
      target,
    ],
    'sign',
    app,
  )
  await run([sdk + '/build-tools/36.0.0/apksigner', 'verify', target], 'verify', app)
}

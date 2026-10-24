import { Result } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodeCrypto from 'node:crypto'
import * as NodeModule from 'node:module'
import { command, root, skill, json } from './process.mjs'
import { readApk } from './phonewire.mjs'

export const phoneOrigin = 'http://127.0.0.1:19278'
const cache = NodeOS.homedir() + '/.cache/vivid-android'
const sdk = NodeOS.homedir() + '/android_sdk'
export const phoneEnvironment = {
  ...process.env,
  PATH: [
    cache + '/node/bin',
    cache + '/tools/node_modules/.bin',
    sdk + '/platform-tools',
    sdk + '/emulator',
    sdk + '/cmdline-tools/latest/bin',
    process.env.PATH,
  ].join(':'),
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
async function inputs(head, cwd) {
  const tree = await command(['git', 'ls-tree', '-r', head], { cwd })
  const lines = tree.split('\n').filter((line) => {
    const path = line.split('\t')[1]
    if (/package.json$|pnpm-lock.yaml$|pnpm-workspace.yaml$|^patches\//u.test(path)) return true
    if (!path.startsWith('apps/mobile/')) return false
    return !/^apps\/mobile\/(src\/|index\.ts$)/u.test(path) || !/\.(tsx?|jsx?)$/u.test(path)
  })
  return NodeCrypto.createHash('sha256')
    .update(
      lines.join('\n') +
        phoneOrigin +
        (await NodeFSP.readFile(skill + '/scripts/profile.py', 'utf8')),
    )
    .digest('hex')
}

/** Coding-agent instructions are not phone bundle inputs. Compare the entire remaining Git tree
 * so a tooling-only commit can reuse identical product bytes without launching Metro. */
async function product(head) {
  const tree = await command(['git', 'ls-tree', '-r', head])
  const source = tree.split('\n').filter((line) => !line.split('\t')[1].startsWith('.agents/'))
  return NodeCrypto.createHash('sha256').update(source.join('\n')).digest('hex')
}

/** A binary can serve another proof head only when native profile, product tree and bytes agree. */
export async function equivalent(head, artifact) {
  return (
    artifact.fingerprint === (await inputs(head, root)) &&
    (await product(head)) === (await product(artifact.head)) &&
    artifact.sha256 === (await apkHash(artifact.file))
  )
}

/** The cache distinguishes a missing receipt from malformed metadata or corrupted bytes. */
async function stored(file) {
  const text = await NodeFSP.readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return text === null ? null : Result.getOrThrow(readApk(text))
}

/** Content-addressed native builds survive runs; only a matching byte receipt permits reuse. */
export async function apk(state, record) {
  const directory = cache + '/apks'
  await NodeFSP.mkdir(directory, { recursive: true })
  const fingerprint = await inputs(state.head, root)
  const target = directory + '/' + state.head + '.apk'
  const receipt = target + '.json'
  const prior = await stored(receipt)
  if (prior !== null) {
    if (await equivalent(state.head, prior)) return { ...prior, mode: 'reuse' }
    throw new Error('APK cache receipt mismatch; retain evidence and inspect the cached artifact')
  }
  const foundation = directory + '/' + fingerprint + '.json'
  const base = await stored(foundation)
  if (base !== null && (await equivalent(state.head, base))) return { ...base, mode: 'reuse' }
  if (NodeOS.loadavg()[0] > NodeOS.availableParallelism())
    throw new Error('Devbox busy; warm the APK on an idle devbox before launching the proof')
  const memory = await NodeFSP.readFile('/proc/meminfo', 'utf8')
  const available = /^MemAvailable:\s+(\d+)/mu.exec(memory)
  if (available === null || Number(available[1]) < 6 * 1024 * 1024)
    throw new Error(
      'APK build needs at least 6 GiB available; warm it before starting the emulator',
    )
  const source = cache + '/source'
  const present = await NodeFSP.stat(source + '/.git').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (present === null) await command(['git', 'clone', '--shared', '--no-checkout', root, source])
  const previousHead = await command(['git', 'rev-parse', 'HEAD'], { cwd: source })
  const nativeChanged = (await inputs(previousHead, source)) !== fingerprint
  await command(['git', 'fetch', 'origin', state.head], { cwd: source })
  await command(['git', 'checkout', '--detach', state.head], { cwd: source })
  const run = (args, name, cwd = source) =>
    command(args, {
      cwd,
      env: phoneEnvironment,
      log: state.evidence + '/apk-' + name + '.json',
      record,
    })
  await run([...pnpm, 'install', '--frozen-lockfile', '--filter', '@vivid/mobile...'], 'install')
  const app = source + '/apps/mobile'
  let mode
  if (base !== null) {
    const artifact = base
    if ((await apkHash(artifact.file)) !== artifact.sha256)
      throw new Error('Native APK checksum mismatch')
    await repack(run, app, artifact, target)
    mode = 'repack'
  } else {
    if (nativeChanged) await NodeFSP.rm(app + '/android', { recursive: true, force: true })
    // native.mjs pins the template to the shipped SDK and prebuilds only if Android is absent.
    await run(['node', 'scripts/native.mjs', 'android', '--prebuild-only'], 'prebuild', app)
    await run(['python3', skill + '/scripts/profile.py', app], 'profile')
    await NodeFSP.writeFile(app + '/android/local.properties', 'sdk.dir=' + sdk + '\n')
    await run(
      [
        './gradlew',
        ':app:assembleRelease',
        '--init-script',
        skill + '/scripts/native.gradle',
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
  await json(foundation, result)
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
  const react = NodeModule.createRequire(
    await NodeFSP.realpath(app + '/node_modules/react-native/package.json'),
  )
  const hermes = react.resolve('hermes-compiler/hermesc/linux64-bin/hermesc')
  await run([hermes, '-O', '-emit-binary', '-out', bundle + '.hbc', bundle], 'hermes', app)
  await run(
    [
      'python3',
      '-c',
      `import sys,zipfile,re
with zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[3],'w') as dst:
 src.getinfo('assets/index.android.bundle')
 for entry in src.infolist():
  signature=re.fullmatch(r'META-INF/(MANIFEST[.]MF|[^/]+[.](SF|RSA|DSA|EC))',entry.filename,re.I)
  if signature or entry.filename == 'assets/index.android.bundle': continue
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
  await run(
    [sdk + '/build-tools/36.0.0/zipalign', '-P', '16', '-f', '4', target, aligned],
    'align',
    app,
  )
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

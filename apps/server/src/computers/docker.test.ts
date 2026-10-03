import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, ComputerState } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Redacted, Result, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import {
  ChildProcessSpawner,
  make as instrumentSpawner,
  type ChildProcessHandle,
} from 'effect/unstable/process/ChildProcessSpawner'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as NodeBuffer from 'node:buffer'
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { commandInvocation, dockerCommand, dockerExecution, dockerMachineLayer } from './docker.js'
import { Machine, MachineKey } from './machine.js'

const image = 'vivid-computer:test'
const context = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '../../../..',
  'infra/computer',
)
const decodeImage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ Size: Schema.Number })),
)

/** Real process adapters distinguish an absent executable from a lost spawned Docker client, without replacing Docker. */
const exerciseReceipts = Effect.fn('Computer.test.receipts')(function* (key: MachineKey) {
  const spawner = yield* ChildProcessSpawner
  const missing = instrumentSpawner(
    Effect.fn('Computer.test.missingDocker')((command) =>
      spawner.spawn(ChildProcess.setEnv(command, { PATH: '/vivid-test-missing-executable' })),
    ),
  )
  const rejected = yield* Effect.flip(
    dockerExecution(key, ['version'], '').pipe(Effect.provideService(ChildProcessSpawner, missing)),
  )
  expect(rejected._tag).toBe('MachineOperationFailed')
  const spawned = yield* Deferred.make<ChildProcessHandle>()
  const instrumented = instrumentSpawner(
    Effect.fn('Computer.test.spawnReceipt')(function* (command) {
      const handle = yield* spawner.spawn(command)
      yield* Deferred.succeed(spawned, handle)
      return handle
    }),
  )
  // Only the captured client is signalled; the in-container process remains independently bounded.
  const invocation = commandInvocation({ key, command: "node -e 'for (;;) {}'", timeoutSeconds: 1 })
  const pending = yield* dockerExecution(key, invocation.args, invocation.input).pipe(
    Effect.provideService(ChildProcessSpawner, instrumented),
    Effect.result,
    Effect.forkChild,
  )
  const handle = yield* Deferred.await(spawned)
  yield* handle.kill({ killSignal: 'SIGKILL' })
  const lost = yield* Fiber.join(pending)
  expect(lost._tag).toBe('Failure')
  if (Result.isFailure(lost)) expect(lost.failure._tag).toBe('MachineExecutionUnknown')
})

/** Docker's own event receipts expose the exec argv; warm steps must create exactly one exec and contain no payload. */
const exerciseArguments = Effect.fn('Computer.test.arguments')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  const since = new Date().toISOString()
  expect(
    (yield* machine.exec({ key, command: 'echo command-private-proof', timeoutSeconds: 10 }))
      .output,
  ).toBe('command-private-proof\n')
  yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
  const events = yield* dockerCommand([
    'events',
    '--since',
    since,
    '--until',
    new Date().toISOString(),
    '--filter',
    `container=vivid-computer-${key}`,
    '--filter',
    'event=exec_create',
    '--format',
    '{{.Action}}',
  ])
  expect(events.exitCode).toBe(0)
  expect(events.output).not.toContain('command-private-proof')
  expect(events.output).not.toContain('"step"')
  expect(events.output.trim().split('\n')).toHaveLength(2)
  expect(events.output).toContain('/bin/bash --noprofile --norc -s')
  expect(events.output).toContain('node /opt/vivid/browser.mjs')
})

/** Real browser actions, including a controlled CDP document, prove reference reuse without a website fixture seam. */
const exerciseBrowser = Effect.fn('Computer.test.browser')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  yield* machine.browse({
    key,
    action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
  })
  const page = yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
  expect(page.title).toContain('Example')
  expect(page.outline).toContain('Example Domain')
  expect(page.outline).toMatch(/\[e[A-Fa-f0-9]+\.[A-Fa-f0-9]+:\d+\]/)
  const refused = yield* Effect.flip(
    machine.browse({ key, action: BrowserAction.cases.Open.make({ address: 'http://127.0.0.1' }) }),
  )
  expect(refused._tag).toBe('BrowserAddressRefused')
  const blocked = yield* machine.exec({
    key,
    timeoutSeconds: 10,
    command:
      'node -e \'const net=require("node:net");const s=net.connect(80,"10.0.0.1");s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));\'',
  })
  expect(blocked.exitCode).toBe(0)
  for (const shortcut of ['Control+W', 'Alt+F4']) {
    expect(
      (yield* Effect.flip(
        machine.browse({ key, action: BrowserAction.cases.Press.make({ key: shortcut }) }),
      ))._tag,
    ).toBe('MachineInputInvalid')
  }
  yield* exerciseReferences(machine, key)
  const seeded = yield* machine.exec({
    key,
    timeoutSeconds: 10,
    command:
      'mkdir -p ~/.vivid/screens; for i in {1..55}; do touch -t 200001010000 ~/.vivid/screens/old-$i.png; done',
  })
  expect(seeded.exitCode).toBe(0)
  const screenshot = yield* machine.browse({ key, action: BrowserAction.cases.Screenshot.make({}) })
  expect(screenshot.outline).toContain('/home/vivid/.vivid/screens/')
  expect(
    (yield* machine.exec({
      key,
      timeoutSeconds: 10,
      command: "find ~/.vivid/screens -name '*.png' | wc -l",
    })).output.trim(),
  ).toBe('50')
  yield* exerciseEmptyPage(machine, key)
})

/** Closing every page through the real CDP seam proves subsequent driver steps recreate a usable page. */
const exerciseEmptyPage = Effect.fn('Computer.test.empty')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  const source =
    'const {chromium}=require("/opt/vivid/node_modules/playwright-core");chromium.connectOverCDP("http://127.0.0.1:9222").then(async browser=>{for(const page of browser.contexts()[0].pages()) await page.close(); await browser.close();});'
  const closed = yield* machine.exec({ key, command: `node -e '${source}'`, timeoutSeconds: 10 })
  expect(closed.exitCode).toBe(0)
  const restored = yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
  expect(restored.address).toBe('about:blank')
  yield* machine.browse({
    key,
    action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
  })
})

/** The fixture changes the browser document through CDP only; driver actions still use the real AX and input APIs. */
const exerciseReferences = Effect.fn('Computer.test.references')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  const html =
    '<html><head><title>Computer input</title></head><body><label for="proof">Message</label><input id="proof"><details><summary>Show detail</summary><p>Expanded detail</p></details></body></html>'
  const source = `const {chromium}=require("/opt/vivid/node_modules/playwright-core");chromium.connectOverCDP("http://127.0.0.1:9222").then(async browser=>{const context=browser.contexts()[0];const page=context.pages()[0];const session=await context.newCDPSession(page);const {frameTree}=await session.send("Page.getFrameTree");await session.send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:${JSON.stringify(html)}});await browser.close();});`
  const prepared = yield* machine.exec({ key, command: `node -e '${source}'`, timeoutSeconds: 10 })
  expect(prepared.exitCode, prepared.output).toBe(0)
  const first = yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
  const field = first.outline.match(/\[([^\]]+)\] textbox "Message"/)
  if (field === null || field[1] === undefined)
    expect.fail('The accessibility tree must expose the labelled input.')
  const target = field[1]
  const again = yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
  expect(again.outline).toContain(`[${target}] textbox "Message"`)
  const since = new Date().toISOString()
  const typed = yield* machine.browse({
    key,
    action: BrowserAction.cases.Type.make({ target, text: 'Typed proof' }),
  })
  expect(typed.outline).toContain('Typed proof')
  const events = yield* dockerCommand([
    'events',
    '--since',
    since,
    '--until',
    new Date().toISOString(),
    '--filter',
    `container=vivid-computer-${key}`,
    '--filter',
    'event=exec_create',
    '--format',
    '{{.Action}}',
  ])
  expect(events.exitCode).toBe(0)
  expect(events.output).not.toContain('Typed proof')
  expect(events.output).not.toContain(target)
  expect(events.output.trim().split('\n')).toHaveLength(1)
  yield* machine.browse({ key, action: BrowserAction.cases.Press.make({ key: 'Tab' }) })
  const detail = typed.outline.match(/\[([^\]]+)\] DisclosureTriangle "Show detail"/)
  if (detail === null || detail[1] === undefined)
    expect.fail('The accessibility tree must expose the disclosure.')
  const clicked = yield* machine.browse({
    key,
    action: BrowserAction.cases.Click.make({ target: detail[1] }),
  })
  expect(clicked.outline).toContain('Expanded detail')
})

/** A persistent cookie proves browser identity, as well as ordinary files, survives a disposable container. */
const saveBrowserIdentity = Effect.fn('Computer.test.identity.save')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  const source =
    'const {chromium}=require("/opt/vivid/node_modules/playwright-core");chromium.connectOverCDP("http://127.0.0.1:9222").then(async browser=>{await browser.contexts()[0].addCookies([{name:"vivid_test",value:"retained",domain:"example.com",path:"/",expires:Math.floor(Date.now()/1000)+3600,secure:true}]);await browser.close();});'
  const saved = yield* machine.exec({ key, command: `node -e '${source}'`, timeoutSeconds: 10 })
  expect(saved.exitCode).toBe(0)
})

/** Inspect only the synthetic test cookie through the real Chromium context after a stop or replacement. */
const expectBrowserIdentity = Effect.fn('Computer.test.identity.read')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  const source =
    'const {chromium}=require("/opt/vivid/node_modules/playwright-core");chromium.connectOverCDP("http://127.0.0.1:9222").then(async browser=>{const cookies=await browser.contexts()[0].cookies("https://example.com");const proof=cookies.find(cookie=>cookie.name==="vivid_test");if(proof===undefined)process.exitCode=1;else process.stdout.write(proof.value);await browser.close();});'
  const cookie = yield* machine.exec({ key, command: `node -e '${source}'`, timeoutSeconds: 10 })
  expect(cookie.exitCode).toBe(0)
  expect(cookie.output).toBe('retained')
})

/** Commands prove non-root cwd, combined receipts and byte limits for both Unicode and binary output. */
const exerciseCommands = Effect.fn('Computer.test.commands')(function* (
  machine: typeof Machine.Service,
  key: MachineKey,
) {
  const greeting = yield* machine.exec({ key, command: 'echo hello', timeoutSeconds: 10 })
  expect(greeting).toEqual({ exitCode: 0, output: 'hello\n', truncated: false })
  const identity = yield* machine.exec({ key, command: 'id -u; pwd', timeoutSeconds: 10 })
  expect(identity.output).toBe('1000\n/home/vivid\n')
  const long = yield* machine.exec({
    key,
    command: 'node -e \'process.stdout.write("é".repeat(40000))\'',
    timeoutSeconds: 10,
  })
  expect(long.truncated).toBe(true)
  expect(NodeBuffer.Buffer.byteLength(long.output)).toBeLessThanOrEqual(65_536)
  expect(long.output).toContain('[output truncated]')
  expect(long.output).not.toContain('�')
  const written = yield* machine.exec({
    key,
    command: 'printf retained > proof.txt',
    timeoutSeconds: 10,
  })
  expect(written.exitCode).toBe(0)

  const binary = yield* machine.exec({
    key,
    command: "node -e 'process.stdout.write(Buffer.alloc(40000,255))'",
    timeoutSeconds: 10,
  })
  expect(binary.truncated).toBe(true)
  expect(NodeBuffer.Buffer.byteLength(binary.output)).toBeLessThanOrEqual(65_536)
})

describe.skipIf(process.env.VIVID_TEST_DOCKER !== '1')('local Computer', () => {
  it.effect(
    'runs a desktop, bounds commands, guards egress, and preserves home through replacement',
    () =>
      Effect.gen(function* () {
        const key = MachineKey.make(`test-${NodeCrypto.randomUUID()}`)
        // Register cleanup before the first resource write, and address only this test's exact names.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* dockerCommand(['container', 'rm', '--force', `vivid-computer-guard-${key}`])
            yield* dockerCommand(['container', 'rm', '--force', `vivid-computer-${key}`])
            yield* dockerCommand(['network', 'rm', `vivid-computer-network-${key}`])
            const volumes = yield* dockerCommand([
              'volume',
              'ls',
              '--filter',
              `name=^vivid-computer-home-${key}$`,
              '--format',
              '{{.Name}}',
            ])
            expect(volumes.exitCode).toBe(0)
            if (volumes.output.trim() !== '') {
              const removed = yield* dockerCommand(['volume', 'rm', `vivid-computer-home-${key}`])
              expect(removed.exitCode).toBe(0)
            }
          }).pipe(
            Effect.catchTag('MachineOperationFailed', () =>
              Effect.sync(() => {
                expect.fail('Docker cleanup could not be completed.')
              }),
            ),
          ),
        )
        const built = yield* ChildProcess.make('docker', ['build', '--tag', image, context], {
          stdout: 'inherit',
          stderr: 'inherit',
        })
        expect(yield* built.exitCode).toBe(0)
        const size = yield* dockerCommand(['image', 'inspect', '--format', '{{json .}}', image])
        const metadata = yield* decodeImage(size.output)
        console.info(`Computer image bytes: ${metadata.Size}`)

        const machine = yield* Machine
        expect(ComputerState.guards.Absent(yield* machine.status(key))).toBe(true)
        const before = performance.now()
        yield* machine.ensure(key)
        const running = yield* machine.status(key)
        if (!ComputerState.guards.Running(running))
          expect.fail('The created Computer must be running')
        console.info(`Computer cold start milliseconds: ${Math.round(performance.now() - before)}`)
        expect(running.screen.address).toBe('/api/computer/screen/websockify')
        const initialScreen = yield* machine.screen(key)
        const direct = new NodeURL.URL(initialScreen.address)
        const screenPort = Number(direct.port)
        expect(screenPort).toBeGreaterThanOrEqual(61000)
        expect(screenPort).toBeLessThanOrEqual(65000)
        direct.protocol = 'http:'
        const screen = yield* HttpClient.get(direct.href)
        expect(screen.status).toBe(405)
        const network = yield* dockerCommand([
          'network',
          'inspect',
          '--format',
          '{{ index .Options "com.docker.network.bridge.enable_icc" }}',
          `vivid-computer-network-${key}`,
        ])
        expect(network.output.trim()).toBe('false')
        const same = yield* machine.ensure(key)
        expect(same).toEqual(running)
        expect(ComputerState.guards.Running(yield* machine.status(key))).toBe(true)
        yield* exerciseReceipts(key)
        yield* exerciseArguments(machine, key)
        yield* exerciseCommands(machine, key)
        yield* exerciseBrowser(machine, key)
        yield* saveBrowserIdentity(machine, key)
        yield* machine.stop(key)
        expect(ComputerState.guards.Stopped(yield* machine.status(key))).toBe(true)
        yield* machine.ensure(key)
        const restartedScreen = yield* machine.screen(key)
        expect(
          Redacted.value(initialScreen.authorization) !==
            Redacted.value(restartedScreen.authorization),
        ).toBe(true)
        const retained = yield* machine.exec({ key, command: 'cat proof.txt', timeoutSeconds: 10 })
        expect(retained.output).toBe('retained')
        yield* expectBrowserIdentity(machine, key)
        yield* machine.stop(key)
        // Replacing the container, not just restarting it, proves the home belongs to the volume.
        const removed = yield* dockerCommand(['container', 'rm', `vivid-computer-${key}`])
        expect(removed.exitCode).toBe(0)
        yield* machine.ensure(key)
        expect(
          (yield* machine.exec({ key, command: 'cat proof.txt', timeoutSeconds: 10 })).output,
        ).toBe('retained')
        yield* expectBrowserIdentity(machine, key)
        const prior = yield* machine.browse({
          key,
          action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
        })
        const timed = yield* machine.exec({
          key,
          command: "node -e 'for (;;) {}'",
          timeoutSeconds: 1,
        })
        expect(timed.exitCode).toBe(124)
        expect(ComputerState.guards.Running(yield* machine.status(key))).toBe(true)
        expect(
          (yield* machine.exec({ key, command: 'echo still-running', timeoutSeconds: 10 })).output,
        ).toBe('still-running\n')
        expect(
          (yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })).title,
        ).toBe(prior.title)
        yield* machine.stop(key)
      }).pipe(
        Effect.provide(dockerMachineLayer(image)),
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeHttpClient.layerNodeHttp),
      ),
    { timeout: 900_000 },
  )
})

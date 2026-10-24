import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { BrowserAction, ComputerState, DesktopAction } from '@vivid/contracts'
import { Clock, Config, Duration, Effect, Function, Layer, Option, Predicate } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { Database } from '../database/client.ts'
import { machineBindings } from './tables.ts'
import { bindings } from './boat/bindings.ts'
import { createdSince } from './boat/created.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { boatMachineLayer } from './boat.ts'
import { Machine, MachineKey } from './machine.ts'

// Explicit cost opt-in and isolated persistence are mandatory. Read presence, never print key values.
const enabled =
  testDatabaseConfigured &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  NodeProcess.env.VIVID_TEST_BOAT_LIVE === '1'
const dependencies = Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)
const provider = boatMachineLayer.pipe(Layer.provideMerge(dependencies))

/** Record only operation timings, never viewer authority, screenshots or private guest output. */
const measured = <A, E, R>(step: string, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => NodeProcess.stdout.write(`${JSON.stringify({ starting: step })}\n`))
    const [duration, result] = yield* Effect.timed(program)
    yield* Effect.logInfo('Boat live proof', { step, milliseconds: Duration.toMillis(duration) })
    yield* Effect.sync(() =>
      NodeProcess.stdout.write(
        `${JSON.stringify({ step, milliseconds: Duration.toMillis(duration) })}\n`,
      ),
    )
    return result
  })

/** Deletion and isolated binding cleanup are registered before the first billable create.
 * A failed deletion stays visible so the operator can reconcile it; no failure detail is logged. */
const cleanup = Effect.fn('BoatLive.cleanup')(function* (key: MachineKey) {
  const saved = yield* bindings()
  const database = yield* Database
  const client = yield* HttpClient.HttpClient
  const apiKey = yield* Config.Redacted('VIVID_BOAT_API_KEY')
  const org = yield* Config.option(Config.NonEmptyString('VIVID_BOAT_ORG'))
  // The provider is built in this process, so this process's own setting says whether the key
  // took an existing machine (`VIVID_BOAT_MACHINE`) or had one created. Only a created one is
  // deleted, and only when Boat's record agrees that it was made after this proof began.
  const adopted = yield* Config.option(Config.String('VIVID_BOAT_MACHINE'))
  const began = yield* Clock.currentTimeMillis
  const billed = Option.match(org, {
    onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
    onSome: (name) => HttpClientRequest.setHeader('X-Boat-Org', name),
  })
  yield* Effect.addFinalizer(() =>
    measured(
      'delete',
      Effect.gen(function* () {
        const binding = yield* saved.load(key)
        if (
          Option.isNone(adopted) &&
          Option.isSome(binding) &&
          binding.value.providerId !== null &&
          (yield* createdSince(binding.value.providerId, began))
        ) {
          const id = binding.value.providerId
          const response = yield* client.execute(
            HttpClientRequest.delete(`https://boat.dev/api/v1/sandboxes/${id}`).pipe(
              HttpClientRequest.bearerToken(apiKey),
              HttpClientRequest.setHeader('X-Ascii-Confirm-Delete', id),
              HttpClientRequest.setHeader('Connection', 'close'),
              billed,
            ),
          )
          expect(response.status >= 200 && response.status < 300).toBe(true)
          yield* Effect.logInfo('Boat live machine deleted', { id })
          yield* Effect.sync(() => NodeProcess.stdout.write(`${JSON.stringify({ deleted: id })}\n`))
        }
        yield* database.run(database.delete(machineBindings).where(eq(machineBindings.key, key)))
      }),
    ).pipe(
      Effect.timeout('60 seconds'),
      Effect.interruptible,
      Effect.catch(() =>
        Effect.sync(() =>
          expect.fail('Live Boat deletion failed; reconcile the provider account.'),
        ),
      ),
    ),
  )
})

/** Public pages exercise real input through the same Machine seam used by every client.
 * Example Domain's current link is obtained from its accessible outline, not guessed. Scroll
 * makes the multilingual page's link visible in Chrome's default window. The Selenium fixture
 * is public and requires no sign-in or submission; replacement and clearing read back values. */
const browserProof = Effect.fn('BoatLive.browser')(function* (
  machine: Machine['Service'],
  key: MachineKey,
) {
  const page = yield* measured(
    'open-and-read',
    machine.browse({
      key,
      egress: false,
      action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
    }),
  )
  expect(page.address).toBe('https://example.com/')
  const read = yield* measured(
    'read-again',
    machine.browse({ key, egress: false, action: BrowserAction.cases.Read.make({}) }),
  )
  expect(read.title).toContain('Example')
  const links = Array.from(read.outline.matchAll(/- link "([^"\n]+)"/g), (match) => match[1])
  const target = links[0]
  if (links.length !== 1 || target === undefined)
    expect.fail('Example Domain must expose exactly one link')
  yield* measured(
    'scroll-link-into-view',
    machine.browse({
      key,
      egress: false,
      action: BrowserAction.cases.Scroll.make({ direction: 'down', notches: 12 }),
    }),
  )
  const clicked = yield* measured(
    'click-link',
    machine.browse({ key, egress: false, action: BrowserAction.cases.Click.make({ target }) }),
  )
  expect(clicked.address).not.toBe(read.address)
  expect(clicked.address).toContain('iana.org')
  expect(clicked.outline.length).toBeGreaterThan(0)
  const form = yield* measured(
    'open-form',
    machine.browse({
      key,
      egress: false,
      action: BrowserAction.cases.Open.make({
        address: 'https://www.selenium.dev/selenium/web/web-form.html',
      }),
    }),
  )
  expect(form.address).toContain('/web-form.html')
  const typed = yield* measured(
    'type-and-read-back',
    machine.browse({
      key,
      egress: false,
      action: BrowserAction.cases.Type.make({
        target: 'Text input',
        text: 'Vivid browser input proof',
      }),
    }),
  )
  expect(typed.outline).toContain('textbox "Text input": Vivid browser input proof')
  const replaced = yield* measured(
    'replace-and-read-back',
    machine.browse({
      key,
      egress: false,
      action: BrowserAction.cases.Type.make({
        target: 'Text input',
        text: 'Vivid replacement proof',
      }),
    }),
  )
  expect(replaced.outline).toContain('textbox "Text input": Vivid replacement proof')
  expect(replaced.outline).not.toContain('Vivid browser input proof')
  yield* measured(
    'clear-and-read-back',
    machine.browse({
      key,
      egress: false,
      action: BrowserAction.cases.Type.make({ target: 'Text input', text: '' }),
    }),
  )
})

/** Exercise the owned Machine seam against a real guest, with explicit compute opt-in. */
describe.skipIf(!enabled)('Boat native guest live proof', () => {
  layer(provider, { excludeTestServices: true })((it) => {
    it.effect(
      'creates, views, clicks a link, types and reads values, archives and resumes the same machine',
      () =>
        Effect.gen(function* () {
          const machine = yield* Machine
          const key = MachineKey.make(NodeCrypto.randomUUID())
          yield* cleanup(key)
          yield* measured('create', machine.ensure(key))
          // A template is usable only when portable archives survive restore, not just preparation.
          const installed = yield* measured(
            'verify-restored-apps',
            machine.exec({
              key,
              command: '/opt/vivid/python/bin/python3 /opt/vivid/computer/catalogue.py verify',
              timeoutSeconds: 60,
            }),
          )
          expect(installed.exitCode).toBe(0)
          const saved = yield* bindings()
          const original = yield* saved.load(key)
          if (Option.isNone(original) || original.value.providerId === null)
            expect.fail('The created Computer must have a durable identity')
          yield* Effect.logInfo('Boat live machine created', { id: original.value.providerId })
          yield* Effect.sync(() =>
            NodeProcess.stdout.write(`${JSON.stringify({ created: original.value.providerId })}\n`),
          )
          const created = yield* measured('viewer', machine.status(key))
          if (!ComputerState.guards.Running(created))
            expect.fail('The created Computer must be running')
          expect(Predicate.isTagged(created.screen, 'Viewer')).toBe(true)
          const view = yield* measured(
            'look',
            machine.desktop({ key, action: DesktopAction.cases.Look.make({}) }),
          )
          expect(view.picture.length > 0 && view.width > 0 && view.height > 0).toBe(true)
          yield* browserProof(machine, key)
          const written = yield* measured(
            'write-marker',
            machine.exec({
              key,
              command: `printf '%s' '${key}' > "$HOME/vivid-live-proof"`,
              timeoutSeconds: 30,
            }),
          )
          expect(written.exitCode).toBe(0)
          yield* measured('archive', machine.stop(key))
          expect(ComputerState.guards.Stopped(yield* machine.status(key))).toBe(true)
          yield* measured('resume', machine.ensure(key))
          const restoredBinding = yield* saved.load(key)
          if (Option.isNone(restoredBinding)) expect.fail('Resume must preserve the binding')
          expect(restoredBinding.value.providerId).toBe(original.value.providerId)
          const marker = yield* measured(
            'read-marker',
            machine.exec({ key, command: 'cat "$HOME/vivid-live-proof"', timeoutSeconds: 30 }),
          )
          expect(marker.exitCode).toBe(0)
          expect(marker.output).toBe(key)
          const resumed = yield* measured('resumed-viewer', machine.status(key))
          if (!ComputerState.guards.Running(resumed))
            expect.fail('The resumed Computer must be running')
          expect(Predicate.isTagged(resumed.screen, 'Viewer')).toBe(true)
          const restored = yield* measured(
            'resumed-look',
            machine.desktop({ key, action: DesktopAction.cases.Look.make({}) }),
          )
          expect(restored.width).toBe(view.width)
          expect(restored.height).toBe(view.height)
        }).pipe(Effect.scoped),
      25 * 60_000,
    )
  })
})

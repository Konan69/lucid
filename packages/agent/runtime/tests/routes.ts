import * as NodeProcess from 'node:process'
import { expect } from '@effect/vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from '@earendil-works/pi-ai/providers/faux'
import { AgentRunError, init } from '@flue/runtime'
import { start } from '@flue/runtime/node'
import { ThreadId } from '@vivid/contracts'
import { Config, Data, Deferred, Effect, Match, Option, Redacted, Schema } from 'effect'
import app from '../src/app.ts'
import { Vivid } from '../src/agents/vivid.ts'
import { disposableStorage } from './schema.ts'

/** Expected non-successful settlements remain distinct from a failure to read settlement. */
export type Settled = Data.TaggedEnum<{
  Completed: { readonly text: string }
  Aborted: {}
  Failed: {}
}>
export const Settled = Data.taggedEnum<Settled>()

/** One signal-deaf faux factory; release is idempotent and registered before queuing. */
export interface Held {
  readonly entered: Effect.Effect<void>
  readonly release: Effect.Effect<void>
}

/** Startup rejected before ownership could transfer to a public Flue stop handle. */
export class RuntimeStartFailed extends Schema.TaggedError<RuntimeStartFailed>()(
  'RuntimeStartFailed',
  {},
  { title: 'Runtime fixture start failed' },
) {}

/** Hono dispatch failed before returning a response; HTTP error responses are still responses. */
export class RouteRequestFailed extends Schema.TaggedError<RouteRequestFailed>()(
  'RouteRequestFailed',
  { path: Schema.String },
  { title: 'Runtime route request failed' },
) {}

/** A missing instance or SDK read failure is not a failed/aborted durable Run. */
export class SettlementReadFailed extends Schema.TaggedError<SettlementReadFailed>()(
  'SettlementReadFailed',
  { threadId: ThreadId, submissionId: Schema.String },
  { title: 'Runtime settlement read failed' },
) {}

/**
 * The worker's configuration still names a product server, so context reads could leave the
 * process. tests/setup.ts removes it before any `Config` read; this is that rule failing loudly.
 */
export class ProductServerConfigured extends Schema.TaggedError<ProductServerConfigured>()(
  'ProductServerConfigured',
  {},
  { title: 'Runtime fixture inherited a product server' },
) {}

/** The fixture's model, and the only provider registered for it. */
const provider = 'fixture'
const model = 'text'

/**
 * `src/agents/vivid.ts` reads `process.env.VIVID_MODEL` at each render, so the model is the one
 * setting a scope can change after import. It is set before Flue starts and restored only after
 * stop. The runtime token and the absent product server are worker configuration instead: they
 * are read through Effect `Config`, whose default provider is copied once (tests/setup.ts).
 */
const fixtureModel = Effect.acquireRelease(
  Effect.sync(() => {
    const inherited = Option.fromUndefinedOr(NodeProcess.env.VIVID_MODEL)
    NodeProcess.env.VIVID_MODEL = `${provider}/${model}`
    return inherited
  }),
  (inherited) =>
    Effect.sync(() => {
      if (Option.isNone(inherited)) delete NodeProcess.env.VIVID_MODEL
      else NodeProcess.env.VIVID_MODEL = inherited.value
    }),
)

/**
 * Faux 0.87.1 providers/faux.js resolveResponse awaits the factory before observing the abort
 * signal in streamWithDeltas. Its public FauxResponseFactory requires a Promise, so this one
 * bridge only runs test-owned coordination. Register release before appendResponses so even
 * failed assertions release the factory before the older Flue stop finalizer drains it.
 */
const heldReply = Effect.fn('RuntimeRoutes.hold')(function* (
  faux: FauxProviderHandle,
  text: string,
) {
  const entered = yield* Deferred.make<void>()
  const released = yield* Deferred.make<void>()
  const release = Deferred.succeed(released, undefined).pipe(Effect.asVoid)
  yield* Effect.addFinalizer(() => release)
  faux.appendResponses([
    () =>
      // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library -- Public pi FauxResponseFactory Promise callback owns only test coordination.
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(released)
          return fauxAssistantMessage(text)
        }),
      ),
  ])
  return { entered: Deferred.await(entered), release } satisfies Held
})

/** Read the public durable settlement once; no bespoke polling or conversation-store internals. */
const settled = Effect.fn('RuntimeRoutes.settled')(function* (
  threadId: ThreadId,
  submissionId: string,
) {
  return yield* Effect.tryPromise({
    try: () => init(Vivid, { id: threadId }).read(submissionId),
    catch: (cause) =>
      cause instanceof AgentRunError ? cause : new SettlementReadFailed({ threadId, submissionId }),
  }).pipe(
    Effect.map((reply) => Settled.Completed({ text: reply.text })),
    Effect.catch((error) => {
      if (!(error instanceof AgentRunError)) return Effect.fail(error)
      return Match.value(error.outcome).pipe(
        Match.when('aborted', () => Effect.succeed(Settled.Aborted())),
        Match.when('failed', () => Effect.succeed(Settled.Failed())),
        Match.exhaustive,
      )
    }),
  )
})

const stopFailed = Effect.sync(() => expect.fail('Runtime route fixture stop failed'))

/**
 * Production Hono + Vivid + flueStorage on one disposable schema, with the public Node
 * start/stop lifecycle. Flue 2.2.2 dispatch requireRuntime resolves the runtime per request;
 * neither this module nor the application imports db.ts. Cases must await scope closure
 * before reacquiring: Flue has one runtime per module graph and stop owns its reset.
 */
export const routes = Effect.fn('RuntimeTest.routes')(function* () {
  // The same read as src/app.ts requireRuntimeToken, from the same worker configuration.
  const token = yield* Config.Redacted('VIVID_RUNTIME_TOKEN')
  // client.ts actingLayer reads this before it builds a client: absent means no product RPC.
  const server = yield* Config.option(Config.URL('VIVID_SERVER_URL'))
  if (Option.isSome(server)) return yield* new ProductServerConfigured({})
  yield* fixtureModel
  const { schema, storage } = yield* disposableStorage
  const faux = fauxProvider({ provider, models: [{ id: model }] })
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => start({ agents: [Vivid], db: storage, providers: [faux.provider] }),
      catch: () => new RuntimeStartFailed({}),
    }),
    (flue) => Effect.tryPromise(() => flue.stop()).pipe(Effect.catch(() => stopFailed)),
  )
  return {
    schema,
    storage,
    /** Only the production app is called; runtime.test is an in-process Request origin. */
    send: Effect.fn('RuntimeRoutes.send')(
      (path: string, input: { readonly method: 'GET' | 'POST'; readonly body?: string }) =>
        Effect.tryPromise({
          // Hono may return synchronously; the adapter must always return a Promise.
          try: async () =>
            await app.fetch(
              new Request(`http://runtime.test${path}`, {
                method: input.method,
                body: input.body,
                headers: {
                  authorization: `Bearer ${Redacted.value(token)}`,
                  'content-type': 'application/json',
                },
              }),
            ),
          catch: () => new RouteRequestFailed({ path }),
        }),
    ),
    /** Inspect the real model-visible registry after Vivid and Flue assemble it. Flue 2.2.2
     * reserves task/activate_skill/read_skill_resource and exposes no schema override; these
     * framework-owned inputs need upstream support before they can carry Vivid's display words. */
    inspectTools: Effect.sync(() =>
      faux.appendResponses([
        (context) => {
          // pi 0.87.1 TranscriptContext carries tool declarations on the leading system message.
          const system = context.messages.find((message) => message.role === 'system')
          if (system === undefined || system.toolsAdded === undefined)
            expect.fail('Vivid must register its tools')
          // Flue's six machine tools are Flue's code and words unchanged (`tools/sandbox.ts`):
          // like the framework's own three they carry no `summary`, and the clients label their
          // steps from the path or the command instead.
          const machine = ['read', 'write', 'edit', 'bash', 'grep', 'glob']
          expect(system.toolsAdded.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(machine),
          )
          const owned = system.toolsAdded.filter(
            (tool) =>
              ![...machine, 'task', 'activate_skill', 'read_skill_resource'].includes(tool.name),
          )
          // Counted with notes mounted, as every runtime has them: the three note tools are in,
          // and the two knowledge-base tools that only a runtime without notes offered are gone.
          // One more than main alone: the Person's computer is ours (`use_person_computer`).
          expect(owned).toHaveLength(30)
          expect(owned.map((tool) => tool.name)).toContain('use_person_computer')
          // Every tool says its step to the Person in `summary`. `ask_person` is the one that
          // does not: its `question` is already that sentence (`tools/ask.ts`, 5 October 2026).
          for (const tool of owned)
            expect(tool.parameters, tool.name).toHaveProperty(
              'required',
              expect.arrayContaining([tool.name === 'ask_person' ? 'question' : 'summary']),
            )
          return fauxAssistantMessage('ready')
        },
      ]),
    ),
    /** A missing queued response fails loudly in the installed faux provider. */
    reply: (text: string) => Effect.sync(() => faux.appendResponses([fauxAssistantMessage(text)])),
    hold: (text: string) => heldReply(faux, text),
    settled,
    modelCalls: Effect.sync(() => faux.state.callCount),
  }
})()

export type Routes = Effect.Success<typeof routes>

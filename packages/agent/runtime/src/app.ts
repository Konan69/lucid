import { createAgentRouter } from '@flue/runtime/routing'
import { Hono } from 'hono'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import './providers/rehearsal.ts'
import { Vivid } from './agents/vivid.ts'
import './providers/explabs.ts'
import { DEFAULT_MODEL } from './providers/opencode.ts'
import { RuntimeAdmissionBody } from '@vivid/contracts'
import { modelDelivery, recordScope } from './delivery.ts'
import { actingFor, threadOriginOf } from './client.ts'
import { loadContext } from './context.ts'

const app = new Hono()

type AppContext = Parameters<Parameters<typeof app.use>[1]>[0]

const runResult = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

/**
 * The runtime token protects every Flue route. The application server is the only holder: no
 * browser, phone or desktop app talks to this process; they talk to the server's gateway, which
 * checks who they are and whether they may see the Thread before it forwards anything here.
 */
// @effect-diagnostics-next-line asyncFunction:off -- Hono middleware owns this Promise callback and next invocation.
const requireRuntimeToken = async (context: AppContext, next: () => Promise<void>) => {
  const configured = await runResult(Config.option(Config.Redacted('VIVID_RUNTIME_TOKEN')))
  if (Result.isFailure(configured) || Option.isNone(configured.success)) {
    return context.json({ error: 'Runtime token is not configured' }, 503)
  }
  if (
    context.req.header('authorization') !== `Bearer ${Redacted.value(configured.success.value)}`
  ) {
    return context.json({ error: 'Unauthorized' }, 401)
  }
  return next()
}

/**
 * Scope and creator initial data are server transport metadata; neither enters Flue's delivery
 * attributes. The body is the contract the server encodes with, so the two cannot drift apart.
 */
const Incoming = Schema.fromJsonString(RuntimeAdmissionBody)
const decodeIncoming = Schema.decodeUnknownOption(Incoming)
const flueRouter = createAgentRouter(Vivid)

/** Cache authority before the synchronous render, then send a freshly constructed, id-free delivery to Flue. */
// @effect-diagnostics-next-line asyncFunction:off -- Hono route handler owns the request and Flue fetch Promise boundary.
const prepareContext = async (context: AppContext) => {
  const incoming = decodeIncoming(await context.req.raw.text())
  if (Option.isNone(incoming)) return context.json({ error: 'Invalid runtime delivery' }, 400)
  const delivery = incoming.value
  if (delivery.threadId !== context.req.param('id'))
    return context.json({ error: 'Wrong Thread' }, 400)
  recordScope(delivery.threadId, delivery.turn, delivery.scope)
  const message = modelDelivery(delivery)
  await runResult(
    loadContext(actingFor(delivery.threadId, message, threadOriginOf(delivery.initialData))),
  )
  const url = new URL(context.req.url)
  url.pathname = `/${encodeURIComponent(delivery.threadId)}`
  return flueRouter.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: context.req.raw.signal,
      body: JSON.stringify({
        ...message,
        initialData: delivery.initialData,
        idempotencyKey: delivery.idempotencyKey,
      }),
    }),
    context.env,
  )
}

// @effect-diagnostics-next-line asyncFunction:off -- Hono invokes this Promise-returning route handler.
app.get('/health', async (context) => {
  const model = await runResult(
    Config.String('VIVID_MODEL').pipe(Config.withDefault(DEFAULT_MODEL)),
  )
  return context.json({
    model: Result.isSuccess(model) ? model.success : DEFAULT_MODEL,
    service: 'vivid-agent-runtime',
    status: 'ok',
  })
})

app.use('/agents/vivid/*', requireRuntimeToken)
app.post('/agents/vivid/:id', prepareContext)
app.route('/agents/vivid', flueRouter)

export default app

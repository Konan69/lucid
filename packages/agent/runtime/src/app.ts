import { createAgentRouter } from '@flue/runtime/routing'
import { Hono } from 'hono'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import './providers/openrouter.ts'
import { Vivid } from './agents/vivid.ts'
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
 * What a delivery says about who it is for, read from the same body Flue is about to admit. Only
 * the two shapes the server sends are named; anything else has nobody behind it.
 */
const Delivered = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literals(['user', 'signal'] as const),
    attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    initialData: Schema.optionalKey(Schema.Unknown),
  }),
)
const decodeDelivered = Schema.decodeUnknownOption(Delivered)

/**
 * Loads the acting Person's context before Flue renders the response to their message. Flue's
 * render is synchronous, so what Vivid knows about the Person, the skills it can use and their
 * time zone have to be in hand first. A delivery this cannot read is passed on untouched: Flue
 * rejects what is malformed, and a Run never fails because context could not be loaded.
 */
const prepareContext = async (context: AppContext, next: () => Promise<void>) => {
  const threadId = context.req.param('id')
  if (context.req.method === 'POST' && threadId !== undefined) {
    const delivered = decodeDelivered(await context.req.raw.clone().text())
    if (Option.isSome(delivered)) {
      const message =
        delivered.value.kind === 'signal'
          ? { kind: 'signal' as const, type: '', body: '', attributes: delivered.value.attributes }
          : { kind: 'user' as const, body: '' }
      const acting = actingFor(threadId, message, threadOriginOf(delivered.value.initialData))
      await runResult(loadContext(acting))
    }
  }
  return next()
}

app.get('/health', async (context) => {
  const model = await runResult(
    Config.String('VIVID_MODEL').pipe(Config.withDefault('openrouter/z-ai/glm-5.3-flash')),
  )
  return context.json({
    model: Result.isSuccess(model) ? model.success : 'openrouter/z-ai/glm-5.3-flash',
    service: 'vivid-agent-runtime',
    status: 'ok',
  })
})

app.use('/agents/vivid/*', requireRuntimeToken)
app.use('/agents/vivid/:id', prepareContext)
app.route('/agents/vivid', createAgentRouter(Vivid))

export default app

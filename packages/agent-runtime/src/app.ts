import { createAgentRouter } from '@flue/runtime/routing'
import { init } from '@flue/runtime'
import { Hono } from 'hono'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { RuntimeRunRequest, RuntimeRunResponse } from '@vivid/contracts'
import './providers/openrouter.ts'
import { Vivid } from './agents/vivid.ts'

const app = new Hono()

type AppContext = Parameters<Parameters<typeof app.use>[1]>[0]

const runResult = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

const runtimeRunRequestDecoder = Schema.decodeUnknownEffect(RuntimeRunRequest)

/** The runtime token protects Flue transport and the server-only Run admission endpoint. */
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
app.use('/internal/runs', requireRuntimeToken)

/** Accepts one Run for Flue; product state remains exclusively in the application server. */
app.post('/internal/runs', async (context) => {
  const program = Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: () => context.req.json(),
      catch: () => new Error('Run request body could not be read'),
    })
    const request = yield* runtimeRunRequestDecoder(body)
    const runtime = init(Vivid, { id: request.threadId })
    const receipt = yield* Effect.tryPromise({
      try: () =>
        runtime.dispatch({
          idempotencyKey: request.idempotencyKey,
          message: {
            kind: 'signal',
            type: request.type,
            body: request.body,
            attributes: request.attributes,
          },
        }),
      catch: () => new Error('Flue did not accept the Run'),
    })
    return RuntimeRunResponse.make({ submissionId: receipt.submissionId })
  })
  const result = await runResult(program)
  return Result.isSuccess(result)
    ? context.json(result.success, 202)
    : context.json({ error: 'Run was not accepted' }, 503)
})

app.route('/agents/vivid', createAgentRouter(Vivid))

export default app

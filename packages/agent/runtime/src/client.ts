import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import { VividRpcClient } from '@vivid/client-runtime'
import type { PersonId, ThreadId } from '@vivid/contracts'
import { runtimeHeaders } from '@vivid/contracts/auth'
import { RuntimeSettings } from './settings.ts'

/**
 * Who Vivid is acting for right now: one Person, in one Thread.
 *
 * Vivid has no identity of its own. Every product call a tool makes is made as the Person whose
 * latest delivered message is in front of the model, and the server checks that Person's access
 * again on every call. A delivery that arrives during a response joins it after the current
 * round of tools (Pi's steer), and the tools that follow act for the joined delivery. The server
 * keeps one response for one Person by refusing another Person's delivery while a Run is working,
 * so the delivery that joins is from the Person already being answered and the acting Person does
 * not change inside a response. A tool never chooses its acting Person.
 */
export interface Acting {
  readonly threadId: ThreadId
  readonly personId: PersonId
}

/** A tool was asked to act and there is no Person behind the message. Nothing is done. */
export class NobodyToActFor extends Schema.TaggedError<NobodyToActFor>()(
  'NobodyToActFor',
  { message: Schema.String },
  { title: 'Nobody to act for' },
) {}

export interface ProductService {
  /**
   * The product client for one Acting pair. The runtime token says the call comes from the
   * runtime; the two headers say for whom. The Layer owns the client's transport scope, so
   * whoever builds it decides how long the client lives.
   */
  readonly as: (acting: Acting) => Layer.Layer<VividRpcClient>
  /** The bare runtime credential, permitted only for the restart scope lookup. */
  readonly bare: Layer.Layer<VividRpcClient>
}

/**
 * The application server as the runtime reaches it. It is a service so the process wires one
 * transport and one credential at startup and a test answers the server itself. The token never
 * leaves this module and is never given to a tool.
 */
export class Product extends Context.Service<Product, ProductService>()('vivid/Runtime/Product') {}

/**
 * One HTTP client serves every tool and context read: it is taken from the process once, here,
 * and each attributed client only adds its headers to it. Building a per-call client therefore
 * opens no connection pool of its own, and closing one cannot close the shared pool.
 */
export const productLayer = Layer.effect(
  Product,
  Effect.gen(function* () {
    const settings = yield* RuntimeSettings
    const http = Layer.succeed(HttpClient.HttpClient, yield* HttpClient.HttpClient)
    const url = new URL('/api/rpc', settings.serverUrl).href
    const authorization = `Bearer ${Redacted.value(settings.token)}`
    return Product.of({
      as: (acting) =>
        VividRpcClient.layer({
          url,
          headers: {
            authorization,
            [runtimeHeaders.thread]: acting.threadId,
            [runtimeHeaders.actor]: acting.personId,
          },
        }).pipe(Layer.provide(http)),
      bare: VividRpcClient.layer({ url, headers: { authorization } }).pipe(Layer.provide(http)),
    })
  }),
)

/**
 * Runs a context read with an RPC client acquired when this call starts and closed when it ends,
 * even inside a longer scope. Tools acquire the attributed Layer for the whole tool program
 * instead (`scope.ts`).
 */
export const asActing = <A, E>(
  product: ProductService,
  acting: Option.Option<Acting>,
  use: (client: VividRpcClient['Service']) => Effect.Effect<A, E>,
) =>
  Option.match(acting, {
    onNone: () =>
      Effect.fail(
        new NobodyToActFor({ message: 'There is no Person behind this message to act for.' }),
      ),
    onSome: (who) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(product.as(who))
          return yield* use(Context.get(context, VividRpcClient))
        }),
      ),
  })

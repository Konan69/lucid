import { VividApi } from '@vivid/contracts/api'
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import * as HttpApiClient from 'effect/unstable/httpapi/HttpApiClient'

/**
 * The typed client for the application server, derived from `VividApi`.
 *
 * Nothing here is written by hand: the methods, their payloads, their decoded responses and their
 * tagged failures all come from the one API declaration in `@vivid/contracts/api`. Renaming an
 * endpoint or changing a schema on the server is therefore a compile error in every client, which
 * is the property a hand-written `request<T>(path)` cast can never have.
 *
 * It needs an `HttpClient` from its environment, so each surface chooses its own transport:
 * `FetchHttpClient.layer` in the browser and in Expo, a test client in tests. `baseUrl` is empty on
 * web, where development is single-origin through the Vite proxy, and the server address on mobile.
 */
export class VividClient extends Context.Service<
  VividClient,
  HttpApiClient.ForApi<typeof VividApi>
>()('vivid/VividClient') {
  static readonly layer = (options: { readonly baseUrl: string }) =>
    Layer.effect(VividClient, HttpApiClient.make(VividApi, { baseUrl: options.baseUrl }))
}

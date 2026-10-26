import type { CellEnv } from './cloudflare.ts'

export { Person } from './person.ts'

const PERSON_PATH = /^\/persons\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\/|$)/u

/**
 * The Worker entry: each request goes to the cell of the Person its path names
 * (`/persons/:personId/...`, the runtime's own routes), found with `idFromName`, so one Person
 * reaches one cell from every node. Anything else has no Person to go to.
 */
export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Durable Object and Worker handlers are Promise APIs; this is the framework boundary.
  async fetch(request: Request, env: CellEnv): Promise<Response> {
    const match = PERSON_PATH.exec(new URL(request.url).pathname)
    if (match === null || match[1] === undefined) return new Response('no person', { status: 404 })
    return env.PERSON.get(env.PERSON.idFromName(match[1])).fetch(request)
  },
}

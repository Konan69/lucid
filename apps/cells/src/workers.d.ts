/** celld 0.6.2 stores ctx/env on this native base and uses its inheritance to authorize RPC. */
declare module 'cloudflare:workers' {
  export class DurableObject<State, Environment> {
    protected readonly ctx: State
    protected readonly env: Environment
    constructor(state: State, environment: Environment)
  }
}

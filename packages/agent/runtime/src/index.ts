/**
 * What another package may read of the runtime by name, through `@vivid/agent-runtime`.
 *
 * The application server is the only reader, and only from its tests: its procedure catalogue is
 * checked against the tools these factories register, and its delivery shapes against how the
 * runtime renders them for the model. Reaching a runtime file by relative path is refused by
 * `vivid/no-cross-package-import`, so this file and the `./sandbox` and `./scope` entries in
 * `package.json` are the whole surface. The production runtime starts from `src/app.ts`, not here.
 */

export * as views from './tools/views.ts'

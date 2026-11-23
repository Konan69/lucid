# Structure

Where everything lives, and where the things the other documents describe will live. Read this
before adding a file. Extend it in the same change that adds a directory.

## Rules

1. **One word per file and per directory.** The directory carries the context:
   `agent/runtime`, never `agent-runtime`; `watches/store.ts`, never `watch-store.ts`. Components are
   one PascalCase word (`integration/Card.tsx`). Allowed suffixes: `.test.ts(x)`, `.live.test.ts`,
   `.server.ts`, the React Native platform suffixes, and tool configs that a tool names for us.
2. **Group what changes together.** A group directory (`agent/`, `design/`, `client/`) exists
   because its members share a reason to change, not because there are two of them yet.
3. **Backend logic lives in `apps/server`, by domain.** A package exists only for code that more
   than one app imports. Nothing in `packages/` owns a database table or a scheduler.
4. **One declaration per boundary.** Wire schemas and `VividRpc` are declared once
   in `packages/contracts`; RPC clients are derived in `packages/client/rpc`. Plain HTTP adapters
   live in the server and their owning domains; there is no `VividApi` declaration today. Do not
   duplicate domain types or add untyped requests.
5. **No `utils`, `helpers`, `common`, `shared`, `misc` or `lib` dumping grounds.** Name the thing.
6. **Every domain directory holds one `README.md` that is true.** While a directory is only
   scaffolded it says what belongs there, which document defines it, and that it is not built.
   When the first real file lands, the README is rewritten in the same change to say what the
   domain owns, what each file is for, and the invariants a newcomer must not break. A README that
   says "not built" beside working code is a defect.

## Enforcement

`pnpm structure` checks source filenames, package directories, module responsibilities, and server import layering through `scripts/structure.mjs`. The gate's policy stage runs it on every push. The filesystem check owns package names. An Oxlint JavaScript plugin reads the parser's AST for value imports, so type-only imports remain legal. `scripts/structure.json` enables only these structural rules.

## The tree

`●` exists · `◐` exists, moving here · `○` scaffolded, not built

```
apps/
  web/        ● Vite + React. Person-facing surface.
  mobile/     ● Expo. Same surface, native.
  desktop/    ● Electron shell around the web renderer.
  server/     ● The application server. ALL product logic. See "Server" below.
  cells/      ● The celld Worker: one Person cell per Person, memory, the Pi host.

packages/
  contracts/  ● The only declaration of every boundary.
    src/rpc.ts        ● VividRpc — every product call
    src/<domain>.ts   ● wire schemas, one file per domain

  client/             what every app needs to talk to the server
    rpc/      ● derived VividRpc clients over HTTP and WebSocket
    state/    ● shared view logic, live cache, subscriptions and optimistic writes

  agent/              everything that is Lucid-the-model rather than Lucid-the-product
    runtime/  ● Pi Durable inside the Person cell: conversation execution, history, memory
    runtime/src/tools/      ● the tools Lucid can call; product tools are RPC calls to the server
    runtime/src/providers/  ● OpenCode Go and OpenRouter, and the scripted rehearsal model
    skills/   ● the built-in skill procedures and their manifest, read by cells and the server
    prompts/  ○ nothing here; the instructions live in runtime/src/agents/vivid.ts
    evals/    ○ nothing here; live checks are `.live.test.ts` files beside the code

  design/             one visual language for three surfaces
    tokens/   ● colour, type, radius, motion values; web CSS + generated native
    marks/    ● Lucid's face and third-party service marks as data, drawn by web and native
    motion/   ○ shared durations, curves and spring values

  compiler/   ● stops direct compiler commands, so repository checks own typechecking

The Person's machine (docs/04-computer.md) has no package. The Boat provider is built in
apps/server/src/computers, and the desktop app owns local Computer access.

infra/        ● Alchemy stack modules        scripts/  ● repository tooling
docs/         ● these documents              tools/    ● vendored lint plugins
refs/         · ignored: third-party source, including Effect at the pinned tag
```

The chosen runtime host is one celld Person cell with native Pi Durable Object SQLite
([Runtime cells](27-runtime-cells.md)). Host, Notes, infrastructure, and verification integration
are in progress. celld owns activation, ownership, and idle lifecycle; Pi owns durable execution.
Product PostgreSQL remains in the server. The deleted runtime PG adapter has no replacement
migration owner.

## Server

`apps/server/src` has thin shared infrastructure and one directory per domain. A domain never
imports another domain's internals, only its exported service. `handlers.ts` holds no SQL and no
rule; `store.ts` holds no HTTP or RPC type.

```
main.ts  config.ts
auth/  builds/  database/  http/  live/  observability/  rpc/  runtime/

actions/  activity/  appearance/  approvals/  artifacts/  audit/  channels/  code/  companies/
computers/  connections/  decisions/  drafts/  dreams/  feed/  forget/  inputs/  library/
notifications/  owed/  projects/  push/  rules/  runs/  search/  settings/  skills/  threads/
todos/  updates/  watches/  work/

not built: people/  rooms/
```

[Architecture](29-architecture.md#server-domains) lists every domain, grouped, with what it owns
and the outside service it calls.

Most persisted domains use `tables.ts` · `store.ts` · `handlers.ts` and behavior tests. Provider
and projection domains contain only their actual concerns; schedulers and ingestion have named
modules (`watches/lifecycle.ts`, `library/ingest.ts`). Composition adapters may import domain
Layers and handlers; domain-to-domain calls go through exported services.

## Apps

Web, mobile and desktop use the same three layers, so a feature lands in the same place on each:

```
screen/<Name>.tsx     one route or pane; composes ui, owns no request
ui/<group>/<Name>.tsx presentational components; no data access
data/<domain>.ts      programs over @vivid/client-runtime for one domain; no JSX
```

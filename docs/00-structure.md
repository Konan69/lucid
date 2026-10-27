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

packages/
  contracts/  ● The only declaration of every boundary.
    src/rpc.ts        ● VividRpc — every product call
    src/<domain>.ts   ● wire schemas, one file per domain

  client/             what every app needs to talk to the server
    rpc/      ● derived VividRpc clients over HTTP and WebSocket
    state/    ● shared view logic, live cache, subscriptions and optimistic writes

  agent/              everything that is Vivid-the-model rather than Vivid-the-product
    runtime/  ◐ Pi Durable: conversation execution, history, model adapter; moving to Person cells
    runtime/src/tools/      ● the tools Vivid can call; each one is an RPC call to the server
    runtime/src/providers/  ● the model gateway provider, and the scripted rehearsal model
    prompts/  ○ nothing here; the instructions live in runtime/src/agents/vivid.ts
    skills/   ○ nothing here; skills are server records (apps/server/src/skills)
    evals/    ○ nothing here; live checks are `.live.test.ts` files beside the code

  design/             one visual language for three surfaces
    tokens/   ● colour, type, radius, motion values; web CSS + generated native
    marks/    ● Vivid's face and third-party service marks as data, drawn by web and native
    motion/   ○ shared durations, curves and spring values

  computer/           the Person's machine (docs/04-computer.md)
    state/    ● manifest, capture, restore, archive; external state sync remains planned
    machine/  ○ nothing here; the provider boundary is built in apps/server/src/computers
    desktop/  ○ nothing here; viewing is built in the server and the apps, take-over is not built
    device/   ○ the local daemon on the Person's own computer: permissioned exec, copy in and out

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
database/  auth/  http/  rpc/  runtime/          infrastructure and composition adapters

people/         ○ Person profile and preferences (not built)             docs/12
companies/      ● Company, Membership, invitation                        docs/12, 22
projects/       ● recursive work containers, inheritance                 docs/12
threads/        ● Threads, audience, deliveries, Run records, pictures   docs/03, 07, 22
runs/           ○ the durable work log (not built; records are in threads/) docs/14
inputs/         ● Input requests: questions a Run cannot answer alone    docs/03
approvals/      ● the trust loop: gate, record, runner, replay           docs/22
rules/          ● standing rules that pre-decide actions, and the judge  docs/22
artifacts/      ● Thread documents, immutable versions and runtime tools docs/14
notifications/  ● what needs a Person's attention                        docs/22
library/        ● Library items, folders, ingest, search                 docs/03
connections/    ● Integrations on Executor: accounts, sign-in, tools     docs/22
skills/         ● saved procedures and the ones Vivid ships with         docs/22
memory/         ● memory on HelixDB: extraction, graph, recall, the page docs/25
computers/      ● a machine per Person: Boat and local providers, browser, desktop  docs/04
code/           ● programs Vivid writes, run on the Person's Computer    docs/22
search/         ● the search palette across a workspace                  docs/03
live/           ● change topics that keep every client current           docs/09
rooms/          ○ Vivid-to-Vivid across People and Companies (not built) docs/06
settings/       ● theme and per-Person settings                          docs/09
audit/          ● the append-only record of consequential actions        docs/22
```

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

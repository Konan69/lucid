# Structure

Where everything lives, and where the things the other documents describe will live. Read this
before adding a file. Extend it in the same change that adds a directory.

## Rules

1. **One word per file and per directory.** The directory carries the context:
   `agent/runtime`, never `agent-runtime`; `tasks/store.ts`, never `task-store.ts`. Components are
   one PascalCase word (`connector/Card.tsx`). Allowed suffixes: `.test.ts(x)`, `.live.test.ts`,
   `.server.ts`, the React Native platform suffixes, and tool configs that a tool names for us.
2. **Group what changes together.** A group directory (`agent/`, `design/`, `client/`) exists
   because its members share a reason to change, not because there are two of them yet.
3. **Backend logic lives in `apps/server`, by domain.** A package exists only for code that more
   than one app imports. Nothing in `packages/` owns a database table or a scheduler.
4. **One declaration per boundary.** Wire types, the RPC group and the HTTP API are declared once
   in `packages/contracts`; every client is derived. No app hand-writes a path, a response type or
   a copy of a domain type.
5. **No `utils`, `helpers`, `common`, `shared`, `misc` or `lib` dumping grounds.** Name the thing.
6. **A scaffolded directory holds one `README.md`** saying what belongs there, which document
   defines it, and that it is not built. Delete the README when the first real file lands.

## Enforcement

`pnpm structure` runs [konsistent](https://github.com/vercel-labs/konsistent) against
`konsistent.json`, and `.husky/pre-push` runs it on every push. It fails on a multi-word source
file or package directory, on a `utils`/`helpers`/`common`/`shared`/`misc` module, on a server
`handlers.ts` that imports Drizzle, and on a server `store.ts` that imports an HTTP or RPC module.
The `!` entries in `konsistent.json` are the consolidations still owed below; delete each exception
in the change that pays it. Add a convention here whenever this document gains a rule a machine
can check.

## The tree

`●` exists · `◐` exists, moving here · `○` scaffolded, not built

```
apps/
  web/        ● Vite + React. Person-facing surface.
  mobile/     ● Expo. Same surface, native.
  desktop/    ● Electron shell around the web renderer.
  server/     ◐ The application server. ALL product logic. See "Server" below.

packages/
  contracts/  ● The only declaration of every boundary.
    src/api.ts        ● VividApi — the plain-HTTP surface
    src/rpc.ts        ● VividRpc — every product call
    src/<domain>.ts   ◐ wire schemas, one file per domain (today: index.ts + runtime.ts)

  client/             what every app needs to talk to the server
    rpc/      ◐ derived VividRpc + VividApi clients (today: packages/client/rpc)
    state/    ○ one client data layer: cache, live updates, optimistic writes, Thread lanes

  agent/              everything that is Vivid-the-model rather than Vivid-the-product
    runtime/  ◐ Flue: conversation transport, history, model adapter (today: packages/agent/runtime)
    prompts/  ○ Vivid's instructions and their fragments, versioned and testable
    tools/    ◐ the tools Vivid can call; each one is an RPC call to the server
    skills/   ○ Agent Skills mounted into a Run
    evals/    ○ `.live.test.ts` behavioural evaluations, one claim per file

  design/             one visual language for three surfaces
    tokens/   ◐ colour, type, radius, motion values; web CSS + generated native (today: packages/design-tokens)
    marks/    ○ Vivid's face and third-party service marks as data, drawn by web and native
    motion/   ○ shared durations, curves and spring values

  computer/           the Person's machine (docs/04-computer.md)
    state/    ◐ manifest, capture, restore, archive (today: packages/computer)
    machine/  ○ the MachineProvider boundary and its boat.dev implementation
    desktop/  ○ viewing and taking over the desktop from a client
    device/   ○ the local daemon on the Person's own computer: permissioned exec, copy in and out

infra/        ● Alchemy stack modules        scripts/  ● repository tooling
docs/         ● these documents              tools/    ● vendored lint plugins
refs/         · ignored: third-party source, including Effect at the pinned tag
```

## Server

`apps/server/src` has thin shared infrastructure and one directory per domain. A domain never
imports another domain's internals, only its exported service. `handlers.ts` holds no SQL and no
rule; `store.ts` holds no HTTP or RPC type.

```
main.ts  config.ts
database/  auth/  http/  rpc/  runtime/          shared infrastructure; never imports a domain

people/         ○ Person profile and preferences                         docs/12
companies/      ◐ Company, Membership, invitation                        docs/12
projects/       ◐ recursive work containers, inheritance                 docs/12
threads/        ◐ Thread index, lifecycle shelves, lanes                 docs/03, 07
runs/           ○ one bounded attempt; the durable work log              docs/14
inputs/         ○ Input requests: questions a Run cannot answer alone    docs/03
approvals/      ○ authorization for one consequential action             docs/14
artifacts/      ○ versioned inputs and outputs of a Run                  docs/14
tasks/          ◐ Tasks, follow-ups, the follow-up scheduler             docs/15
notifications/  ◐ what needs a Person's attention                        docs/15
routines/       ◐ Routines, Occurrences, templates, the scheduler        docs/13
library/        ◐ Library items, folders, ingest, search                 docs/03
connections/    ◐ authorized external accounts, OAuth, provider calls    docs/14
skills/         ○ procedures Vivid learned; may become Routines          docs/13
computers/      ○ which machine a Person has; lifecycle; archive keys    docs/04, 18
rooms/          ○ Vivid-to-Vivid and shared Threads                      docs/06
settings/       ◐ theme and per-Person settings                          docs/09
audit/          ○ who did what, for Company admins                       docs/18
```

Each built domain is `tables.ts` · `store.ts` · `handlers.ts` · `<name>.test.ts`, plus named files
for real sub-concerns (`tasks/followups.ts`, `routines/scheduler.ts`, `library/ingest.ts`).

## Apps

Web, mobile and desktop use the same three layers, so a feature lands in the same place on each:

```
screen/<Name>.tsx     one route or pane; composes ui, owns no request
ui/<group>/<Name>.tsx presentational components; no data access
data/<domain>.ts      programs over @vivid/client for one domain; no JSX
```

## Consolidation owed

These are duplicates the structure above removes. Each is one change.

| Today                                                                    | Becomes                                    |
| ------------------------------------------------------------------------ | ------------------------------------------ |
| Service marks drawn twice (web 144 lines, mobile 127) and the face twice | `design/marks` as data, two thin renderers |

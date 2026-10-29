# Vivid

One person, one Vivid—simple alone and organizational by design.

Vivid watches Integration events and posts useful updates to the Feed.

Vivid is an AI teammate for everyday work, reached through a Thread. This repository holds the
whole product: web, mobile, desktop, application server, conversation runtime, shared contracts, tests,
and design documents. Backend product logic lives in `apps/server`, organized by domain.

## Start

Requires Node 24 or newer, pnpm `12.4.2`, and Docker for local PostgreSQL. Set `AUTH_SECRET`,
`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, and `VIVID_RUNTIME_TOKEN` in the environment before starting the stack.
`AUTH_SECRET` needs at least 32 characters, 12 distinct characters, and 3 character classes.
See [Infrastructure](docs/19-infrastructure.md) for configuration and current setup limits.

```sh
pnpm install
pnpm infra:verify
pnpm infra:dev
```

Alchemy owns the local stack, including product PostgreSQL 18 on port `55433`, server (`8787`),
and web (`5178`). Product migrations run auth then product. Runtime startup is transitioning to
[Person cells](docs/27-runtime-cells.md); the existing Node/PG wiring is not a working cell launch.
Cell host, Notes, infrastructure, and verification integration are in progress and unproven.
Keep the real local database, cell storage, and Alchemy state read/copy only during tests and
audits. Product database tests require disposable PostgreSQL through `VIVID_TEST_DATABASE_URL`;
runtime proofs require disposable cells with native Pi SQLite.

The separate [mobile app](apps/mobile/README.md) uses Expo; the [desktop app](apps/desktop/README.md)
is an Electron shell around the web renderer. Both connect to the same application server.

Workspace settings, dependency catalogs, overrides, build approvals, and patches live in
`pnpm-workspace.yaml`; `packageManager` and `engines.pnpm` pin pnpm.

Useful checks:

```sh
pnpm check:package-manager
pnpm check:versions
pnpm audit:effect-boundaries
pnpm check:migrations
pnpm structure
pnpm lint
pnpm format
```

For code changes, `pnpm gate` runs every stage (policy, lint, format, typecheck, tooling tests,
tests) and replays whatever did not change; the push hook runs the same command. `pnpm gate
affected` and `pnpm gate focused <test files>` are the faster loops. Avoid concurrent TypeScript
graphs or a typecheck alongside a build.

## Runtime and persistence

The chosen runtime is one celld cell per Person with a native Pi Durable Harness over Durable
Object SQLite. celld owns activation, ownership, and idle lifecycle. Pi owns conversation
execution, history, tasks, queues, deduplication, wait, abort, and restart. The existing Pi `1.2.0`
integration is moving to `1.4.0`. Vivid serves projected conversation state through its gateway.
Product metadata, authorization, Routines, Library, and other product records belong to the
server. Tools in `packages/agent/runtime/src/tools` call the server's schema-derived `VividRpc`
contract. Shared clients live in `packages/client/rpc`, and shared view logic in
`packages/client/state`.

Vivid's replies use OpenCode Go (`OPENCODE_API_KEY`,
`packages/agent/runtime/src/providers/opencode.ts`); the default is `opencode-go/glm-5.3-flash`.
Server title and decision calls use OpenRouter (`OPENROUTER_API_KEY`).
Vivid has no model retry or fallback layer of its own; the gateway fails over upstreams and
Pi handles generation retries.

PostgreSQL stores product records, including auth, Company/Membership, Thread metadata, Runs,
and Library. Conversations and Notes belong to the Person cell's SQLite. HelixDB holds the
knowledge graph and embeddings. Integrations use Executor; the Computer uses Boat, proven against real Boat on 3 October 2026. All of them are required: the
server does not start without their settings (`apps/server/README.md`, "External capabilities").
The hosted stack runs HelixDB and Executor itself; Boat is an outside service. Code and
contracts call an authorized service relationship a `Connection`; every Person-facing string
calls it an **Integration**.

The Library accepts PDF, Markdown, and plain-text files up to 10 MiB each. The server stores
bytes and nested folders in PostgreSQL and indexes extracted passages with `tsvector` and a GIN
index. `search_library` returns filename/page citations. Library retrieval is keyword-based,
without OCR or embeddings; HelixDB memory is a separate system.

## Documents

1. [Structure](docs/00-structure.md). Ownership and file placement.
2. [Principle](docs/01-principle.md) and [Surface](docs/03-surface.md). Product direction and its history.
3. [Main screen](docs/07-main-screen.md) and [Design language](docs/08-design-language.md). Design proposals and references.
4. [Design-system lint](docs/designlint.md). Executable contracts and warning ratchets.
5. [Company and projects](docs/12-company-and-projects.md). The agreed model and open decisions.
6. [Current feature status](docs/14-product-feature-set-and-grok-bot-parity.md). What works, how it was checked, and what is missing.
7. [One product](docs/22-one-product.md). Current product direction; domain READMEs explain implemented boundaries.

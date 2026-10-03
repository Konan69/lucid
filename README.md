# Vivid

One person, one Vivid—simple alone and organizational by design.

Reminders and anything to do once at a time are one-off Routines. Vivid resolves the Person's
local date-time, fires once and retains its Thread and Occurrence.

Vivid is an AI teammate for everyday work: an agent that works alongside a person on their real
tools. The first screen is already the thread, and nothing has to be configured before the first
message. It is not a coding tool.

This repository is the collaboration-ready product slice. It contains the frontend, application
backend shell, shared product contracts, mock data, design system, visible behavior, and the small
Flue runtime adapter needed to power conversations and demo scheduled routines.

The proprietary execution layer is not included: production scheduler ownership and recovery,
connector and tool-call implementations, computer control, credential handling, and the research
or reconstructed sources behind those systems. Product screens may show fixture states for these
features, but the fixtures do not define their implementation.

## Start

```sh
pnpm install
pnpm db:up
cp .env.example .env
# Add an Experiential Labs gateway key, auth secret, and local runtime token to that ignored file.
pnpm --filter @vivid/agent-runtime dev
pnpm --filter @vivid/web dev
```

The shared local database is `postgres://vivid:vivid@127.0.0.1:55433/vivid`. Infrastructure is local-first and nothing is deployed. Alchemy is the source of truth for the intended AWS deployment when that work begins.

The separate iOS/Android app lives in [apps/mobile](apps/mobile/README.md). Run it
with `pnpm --filter @vivid/mobile dev`; its README covers phone connections and
the current feature coverage.

The repository requires pnpm `12.4.2`, pinned by `packageManager` and `engines.pnpm`. Project settings, catalogs, build-script approvals, overrides, and patches live in `pnpm-workspace.yaml`.

Useful checks:

```sh
pnpm check:package-manager
pnpm check:versions
pnpm audit:effect-boundaries
pnpm check:migrations
pnpm lint
pnpm typecheck
pnpm build
```

## Documents

1. [Principle](docs/01-principle.md). The rules every screen has to justify itself against.
2. [Surface](docs/03-surface.md). The user-visible onboarding and conversation behavior.
3. [Main screen](docs/07-main-screen.md). The screen the user lives in: sidebar, thread, and on-demand panel.
4. [Design language](docs/08-design-language.md). The visual rules and interaction character.
5. [Design-system lint](docs/designlint.md). Web component contracts, Tailwind rule ownership, and warning ratchets.
6. [Company and projects](docs/12-company-and-projects.md). The organization and project model visible in the demo.
7. [Feature set and Grok Bot parity](docs/14-product-feature-set-and-grok-bot-parity.md). What works now, what is a fixture, and the product parity target.

## Collaboration boundary

This is a full-stack collaboration boundary, not a frontend-only one. Work may include the web app,
authentication, people and companies, projects, threads, messages, library data, ordinary HTTP APIs,
persistence, tests, and shared product contracts.

The included `packages/agent/runtime` owns the shareable Flue conversation transport, PostgreSQL
persistence, model adapter, local document Library, and a single-process cron adapter for the demo.
The application backend may submit work through this explicit boundary and consume status or results,
but it must not absorb the production scheduling engine, connectors, tool calls, computer transport,
or credential handling. Those integrations will be supplied separately.

The Library accepts PDF, Markdown, and plain-text files up to 10 MB. Files and real nested folders
are stored in PostgreSQL, readable text is chunked into a `tsvector` column with a GIN index, and
Vivid can call the read-only `search_library` tool to answer with filename/page citations. This MVP
uses keyword retrieval and does not include embeddings, OCR, or a vector database. Set
`DATABASE_URL` alongside `EXPLABS_API_KEY` and `VIVID_RUNTIME_TOKEN`; runtime state no longer
needs a `.state/` volume.

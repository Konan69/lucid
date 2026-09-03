# Konan

One person, one Konan—simple alone and organizational by design.

Konan is an AI teammate for everyday work: an agent that works alongside a person on their real
tools. The first screen is already the thread, and nothing has to be configured before the first
message. It is not a coding tool.

This repository is the collaboration-ready product slice. It contains the frontend, application
backend shell, shared product contracts, mock data, design system, visible behavior, and the small
Flue runtime adapter needed to power the initial conversation experience.

The proprietary execution layer is not included: scheduling and recurring-job execution, connector
and tool-call implementations, computer control, credential handling, and the research or
reconstructed sources behind those systems. Product screens may show fixture states for these
features, but the fixtures do not define their implementation.

## Start

```sh
pnpm install
cp packages/agent-runtime/.env.example packages/agent-runtime/.env
# Add an OpenRouter key and a local runtime token to that ignored file.
pnpm --filter @konan/agent-runtime dev
pnpm --filter @konan/web dev
```

Useful checks:

```sh
pnpm build
pnpm typecheck
pnpm lint
```

## Documents

1. [Principle](docs/01-principle.md). The rules every screen has to justify itself against.
2. [Surface](docs/03-surface.md). The user-visible onboarding and conversation behavior.
3. [Main screen](docs/07-main-screen.md). The screen the user lives in: sidebar, thread, and on-demand panel.
4. [Design language](docs/08-design-language.md). The visual rules and interaction character.
5. [Company and projects](docs/12-company-and-projects.md). The organization and project model visible in the demo.
6. [Feature set and Grok Bot parity](docs/14-product-feature-set-and-grok-bot-parity.md). What works now, what is a fixture, and the product parity target.

## Collaboration boundary

This is a full-stack collaboration boundary, not a frontend-only one. Work may include the web app,
authentication, people and companies, projects, threads, messages, library data, ordinary HTTP APIs,
persistence, tests, and shared product contracts.

The included `packages/agent-runtime` owns only the shareable Flue conversation transport,
persistence, and model adapter. The application backend may submit work through this explicit
boundary and consume status or results, but it must not implement or absorb the scheduler,
recurring-task engine, connectors, tool calls, computer transport, or credential handling. Those
integrations will be supplied separately.

# `@vivid/server`

The server owns product logic and persistence, alongside Better Auth's generated identity tables in PostgreSQL. Its Company, Membership,
and invitation concepts use Better Auth's organization-plugin backend, but are configured with the
physical model names `company` and `membership`. That mapping is internal to the auth boundary;
the contracts and HTTP routes use only the Vivid glossary terms.

Browser clients and the Electron web renderer use Better Auth's HttpOnly session cookie. Expo
uses a bearer session token kept in SecureStore on native devices. The device-authorization
plugin supports pairing; mobile implements the code exchange. The desktop shell currently uses
the bundled web sign-in, not a separate bearer-token flow.

## Configuration

Configuration is loaded once, before the HTTP listener is created, through Effect `Config` and
`Schema`. Secret fields are `Redacted` values. Startup reports the variable name and expected shape,
never the supplied value.

| Variable               | Required | Validation                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`         | Yes      | Must parse as a PostgreSQL URL with a host (`postgres://` or `postgresql://`). |
| `AUTH_SECRET`          | Yes      | At least 32 characters, 12 distinct characters, and 3 character classes.       |
| `VIVID_RUNTIME_URL`    | Yes      | Absolute runtime URL; used only by the server.                                 |
| `VIVID_RUNTIME_TOKEN`  | Yes      | Runtime authority, kept redacted and never sent to clients.                    |
| `PORT`                 | No       | Integer from 1 through 65535; defaults to `8787`.                              |
| `PUBLIC_URL`           | No       | If supplied, must be an absolute URL; defaults to `http://localhost:3000`.     |
| `GOOGLE_CLIENT_ID`     | No       | All three Google OAuth variables must be supplied together or omitted.         |
| `GOOGLE_CLIENT_SECRET` | No       | Part of the atomic Google OAuth set; kept redacted.                            |
| `GOOGLE_REDIRECT_URI`  | No       | Required when Google OAuth is enabled and must be an absolute URL.             |

Supply configuration in the process environment. The server's `dev` script does not load an
`.env` file. `.env.example` illustrates values but omits the required runtime URL and token. Local PostgreSQL is
`postgres://vivid:vivid@127.0.0.1:55433/vivid`. Do not put secret values in logs, traces, health
responses, or error messages.

## Run

```sh
pnpm --filter @vivid/server dev
```

Generate auth migrations with `pnpm --filter @vivid/server db:generate`, and product migrations
with `pnpm --filter @vivid/server db:generate:product`. Review generated SQL before applying it.
Root `pnpm db:migrate` applies auth then product migrations; `pnpm check:migrations` validates
both chains. Tests use only a disposable database through `VIVID_TEST_DATABASE_URL`.

`VividRpc` in `packages/contracts/src/rpc.ts` declares product calls: `/api/live` carries JSON
RPC over WebSocket, and `/api/rpc` carries NDJSON RPC over HTTP. `http/router.ts` composes the
plain HTTP adapters for Better Auth, the conversation gateway, Integration sign-in returns,
Routine webhooks, Library bytes, the Computer screen, and health. Better Auth's organization
mutation routes are closed; Company changes go through the audited product RPCs.

## External capabilities

Every part of the product is required. The server does not start without the settings of any of
these, and the failure names the variable (`requiredSetting` in `src/config.ts`):

- **Computer:** Boat. `VIVID_BOAT_API_KEY` and `VIVID_BOAT_TEMPLATE` (`src/computers/README.md`).
- **Memory:** HelixDB at `VIVID_HELIX_URL`, with embeddings through the model gateway.
- **Integrations:** Executor. `VIVID_EXECUTOR_URL`, `VIVID_EXECUTOR_KEY` and
  `VIVID_EXECUTOR_ORGANIZATION`. Account references are in PostgreSQL; Executor holds credentials.
- **Texting:** Photon. `VIVID_PHOTON_PROJECT_ID` and `VIVID_PHOTON_PROJECT_SECRET`.
- **Away notifications:** `VIVID_PUSH_VAPID_PUBLIC`, `VIVID_PUSH_VAPID_PRIVATE` and
  `VIVID_PUSH_SUBJECT`.
- **Models:** the Experiential Labs gateway, `EXPLABS_API_KEY`. Vivid adds no model retry layer.
- **Sign-in with Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`.

There is no server that runs without one of them, and no local stand-in for any of them. What can
still happen is the service itself not answering. That is never a mode the server settles into: it
is a typed failure on the call that met it, the Person or Vivid is told it is not answering right
now, and the next call tries again, so it is over when the service is back, with no restart. Check
[current status](../../docs/14-product-feature-set-and-grok-bot-parity.md) for limits.

Google OAuth above is for account sign-in. Google Integrations need their own operator sign-in
client in Executor; these application credentials do not configure it.

One-off Routines resolve a local date-time using the Person's saved time zone. The existing
Routine scheduler claims the Occurrence, disables the Routine and clears its next time in one
transaction. The Routine, Thread and Occurrence remain available; pending submission receipts
recover across restarts. Past times are refused before insertion.

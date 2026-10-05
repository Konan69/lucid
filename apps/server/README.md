# `@vivid/server`

The server owns product logic and persistence, alongside Better Auth's generated identity tables in PostgreSQL. Its Company, Membership,
and invitation concepts use Better Auth's organization-plugin backend, but are configured with the
physical model names `company` and `membership`. That mapping is internal to the auth boundary;
the contracts and HTTP routes use only the Vivid glossary terms.

Browser clients and the Electron web renderer use Better Auth's HttpOnly session cookie. The
phone app uses a bearer session token kept in SecureStore.

No app signs in with a code a Person reads, types or approves; the device-authorization grant is
not installed. Email and password are typed in each app. Google will not sign anyone in inside an
app's own window, so both apps hand Google to a browser they do not own and get the result back
the same way (`src/auth/signin.ts`, after `@better-auth/electron` and `@better-auth/expo`; the
wire contract is `packages/contracts/src/signin.ts`): the app keeps a secret and sends its
digest, Better Auth's own Google callback issues a one-use code only for the session it has just
made, and the app trades the code and the secret for a session of its own.

- The desktop shell opens the system browser on `GET /api/auth/desktop/google`. The code comes
  back on a loopback address the shell listens on, and the window trades it at
  `POST /api/auth/desktop/session` for a cookie.
- The phone app opens the platform's sign-in sheet on `GET /api/auth/phone/google`. The code
  comes back on the app's own link (`vivid://signin`), which closes the sheet, and the app trades
  it at `POST /api/auth/phone/session` for the session's token.

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

Integrations use Executor (`VIVID_EXECUTOR_URL` and `VIVID_EXECUTOR_KEY`), with account references
stored in PostgreSQL and credentials held by Executor. Memory uses HelixDB when
`VIVID_HELIX_URL` is set; when it is absent, memory calls report unavailable and nothing is learned.
The Computer provider is selected by `VIVID_COMPUTER_PROVIDER` (`boat` or `docker`); no selection
means unavailable. Boat was proven against the real service on 3 October 2026. Check the owning
adapter files and [current status](../../docs/14-product-feature-set-and-grok-bot-parity.md) for
configuration and limits. Models use the Experiential Labs gateway; Vivid adds no model retry layer.

Google OAuth above is for account sign-in. Google Integrations need their own operator sign-in
client in Executor; these application credentials do not configure it.

One-off Routines resolve a local date-time using the Person's saved time zone. The existing
Routine scheduler claims the Occurrence, disables the Routine and clears its next time in one
transaction. The Routine, Thread and Occurrence remain available; pending submission receipts
recover across restarts. Past times are refused before insertion.

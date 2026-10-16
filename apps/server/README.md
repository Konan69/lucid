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
- The phone app opens the system browser on `GET /api/auth/phone/google`. The code comes back
  on the app's own link (`vivid://signin`), which opens the app again, and the app trades it at
  `POST /api/auth/phone/session` for the session's token.

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
| `GOOGLE_CLIENT_ID`     | Yes      | The Google client's id, for sign-in and for Google Integrations.               |
| `GOOGLE_CLIENT_SECRET` | Yes      | That client's secret; kept redacted.                                           |
| `GOOGLE_REDIRECT_URI`  | Yes      | Must be an absolute URL: the address Google returns a sign-in to Vivid to.     |

Supply configuration in the process environment. The server's `dev` script does not load an
`.env` file. `.env.example` lists every setting the server does not start without, these and the
ones under "External capabilities" below. Local PostgreSQL is
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
Library bytes, the Computer screen, and health. Better Auth's organization
mutation routes are closed; Company changes go through the audited product RPCs.

## External capabilities

Every part of the product is required. The server does not start without the settings of any of
these, and the failure names the variable (`requiredSetting` in `src/config.ts`):

- **Computer:** Boat. `VIVID_BOAT_API_KEY` and `VIVID_BOAT_TEMPLATE` (`src/computers/README.md`).
  No SSH key is configured: each connection to a Computer makes its own.
- **Memory:** HelixDB at `VIVID_HELIX_URL`, with embeddings through the model gateway.
- **Integrations:** Executor. `VIVID_EXECUTOR_URL`, `VIVID_EXECUTOR_KEY` and
  `VIVID_EXECUTOR_ORGANIZATION`. Account references are in PostgreSQL; Executor holds credentials.
- **Texting:** Photon. `VIVID_PHOTON_PROJECT_ID` and `VIVID_PHOTON_PROJECT_SECRET`.
- **Away notifications:** `VIVID_PUSH_VAPID_PUBLIC`, `VIVID_PUSH_VAPID_PRIVATE` and
  `VIVID_PUSH_SUBJECT`.
- **Models:** replies come from OpenCode Go in the runtime (`OPENCODE_API_KEY`); the server's own
  calls (memory, embeddings, decisions) use the Experiential Labs gateway, `EXPLABS_API_KEY`. Vivid adds no model retry layer.
- **Sign-in with Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`.

There is no server that runs without one of them, and no local stand-in for any of them. What can
still happen is the service itself not answering. That is never a mode the server settles into: it
is a typed failure on the call that met it, the Person or Vivid is told it is not answering right
now, and the next call tries again, so it is over when the service is back, with no restart. Check
[current status](../../docs/14-product-feature-set-and-grok-bot-parity.md) for limits.

The Google client above is the installation's one Google client. A Person signs in to Vivid with
it, and Executor signs a Person in to a Google Integration with it: Gmail, Calendar, Drive, Docs,
Sheets and Tasks, which the server carries and installs on Executor itself
(`src/connections/google.ts`). The client must allow two return addresses on the server's public
address: `/api/auth/callback/google` and `/api/connections/return`
([One product](../../docs/22-one-product.md), "Google Integrations").

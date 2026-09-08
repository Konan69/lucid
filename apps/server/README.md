# `@vivid/server`

The server keeps Better Auth's generated identity tables in PostgreSQL. Its Company, Membership,
and invitation concepts use Better Auth's organization-plugin backend, but are configured with the
physical model names `company` and `membership`. That mapping is internal to the auth boundary;
the contracts and HTTP routes use only the Vivid glossary terms.

Browser clients use Better Auth's HttpOnly session cookie. Electron and Expo clients use the bearer
plugin with a token they store in their platform credential store. The device-authorization plugin
is enabled for desktop/mobile sign-in when a device flow is preferable; it is not used by browsers.

## Configuration

Configuration is loaded once, before the HTTP listener is created, through Effect `Config` and
`Schema`. Secret fields are `Redacted` values. Startup reports the variable name and expected shape,
never the supplied value.

| Variable | Required | Validation |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Must parse as a PostgreSQL URL with a host (`postgres://` or `postgresql://`). |
| `AUTH_SECRET` | Yes | At least 32 characters, 12 distinct characters, and 3 character classes. |
| `PORT` | No | Integer from 1 through 65535; defaults to `8787`. |
| `PUBLIC_URL` | No | If supplied, must be an absolute URL; defaults to `http://localhost:3000`. |
| `GOOGLE_CLIENT_ID` | No | Optional, but must be paired with `GOOGLE_CLIENT_SECRET`. |
| `GOOGLE_CLIENT_SECRET` | No | Optional, but must be paired with `GOOGLE_CLIENT_ID`; kept redacted. |
| `GOOGLE_REDIRECT_URI` | No | Required when Google OAuth is enabled and must be an absolute URL. |

Copy `.env.example` for a local starting point. Do not put secret values in logs, traces, health
responses, or error messages.

## Run

```sh
pnpm --filter @vivid/server dev
```

Generate/apply the Drizzle migration from this package with `pnpm db:generate` and
`pnpm db:migrate`. Better Auth is mounted directly under `/api/auth`; the request/response API is
declared with Effect HttpApi under `/api`.

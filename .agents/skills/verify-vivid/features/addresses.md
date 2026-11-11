# Accounts added by address

Model requirement: real. Public server authority is DeepWiki at `https://mcp.deepwiki.com/mcp`, which needs no sign-in. No production account is used. The recipe owns and removes only the accounts it creates.

After Launch and worthy Doctor, run `verify feature addresses <run>` and `verify browser addresses <run>`, then Cleanup on the unchanged head. Source is `.agents/skills/verify-vivid/scripts/addresses.mjs`. Evidence is under `addresses/` and `browser/addresses/`.

1. Ask Vivid to add the DeepWiki address and check React documentation. Require one Ready address-added account and a successful real read of `facebook/react` through that account.
2. Ask for another account of DeepWiki. Require two Ready accounts and a successful real read through the new account. Vivid must not say "Nothing here is called" or send the Person to Settings. DeepWiki needs no sign-in, so the second account is created directly.
3. Ask to add `https://mcp.deepwiki.com/mcp/`. Require the same two accounts, no third, and words acknowledging it is already connected.

HTTP uses the public Person gateway. Browser sends the same words through the composer and checks both accounts in Integrations Settings. `reply-*.json` retains Vivid's words, `accounts-*.response.json` the public account lists, `read-*.response.json` each real read, and `step-*.json` each successful checkpoint. A failed step leaves subsequent steps unconfirmed. Native clients remain unproved.

blocked: the current Launch Executor enables `EXECUTOR_URL_ALLOW_LOOPBACK_HTTP` for its disposable catalogue and callbacks, and does not declare `VIVID_EXECUTOR_PUBLIC_ONLY`. The real address registration therefore returns "this Vivid is not set up to add a server by address yet" before an account exists. Recipes 1 and 3 need a proof-owned Executor with public-only egress and no loopback exceptions. Do not assert that declaration on the current loopback-enabled Executor or weaken product enforcement. The required separate configuration remains follow-up work.

Before Launch, retain a POST initialize probe against DeepWiki with the MCP Accept and Content-Type headers. If unavailable, report blocked and name the failed public authority. Do not substitute simulated Executor responses.

## Retry a failed personal account

Run `verify feature retry <run>` and `verify browser retry <run>` to retain blocked verdicts.

Intent: after one failed sign-in, ask Vivid to connect the same Integration again. Require a fresh sign-in card, the stored failure reason when asked why, no instruction to remove the account in Settings, and exactly one account remaining.

blocked: needs a server whose sign-in can be made to fail; covered by the database-backed test `apps/server/src/connections/integrations.test.ts` (replace a Failed personal account). Public servers cannot honestly fail sign-in on demand. Do not fake the failure.

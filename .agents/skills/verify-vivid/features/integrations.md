# Integration grants and result coverage

Model requirement: real. Use the disposable Verify Pulse account installed by Launch. Never use a production Connection or Google account.

Run Launch, Doctor, `verify feature integrations <run>`, `verify browser integrations <run>`, then Cleanup at one committed head. HTTP and model evidence stay under `<evidence>/integrations/`.

The HTTP recipe connects Verify Pulse through Begin/Complete, checks its Granted observation in Connection and FindIntegrations, and calls its read operation through public UseDisplayTool and real Executor. Forty provider records must retain Unknown coverage and Unknown source time. A real model reads the same account through use_tool. Its persisted tool result must contain 25 records, Partial delivered coverage with OutputClipped, the original Unknown source coverage, and server receipt time. The recipe removes only its own Connection in finally.

The source is `.agents/skills/verify-vivid/scripts/integrations.mjs`. Verify Pulse's bounded read is authored in `.agents/skills/verify-vivid/scripts/pulse.mjs`; it has no reviewed external dataset semantics. This proves transport and projection, never Google exhaustion or consent.

The browser recipe (`.agents/skills/verify-vivid/scripts/accessbrowser.mjs` `integrationsBrowser`) connects Verify Pulse from Settings with its key typed inside the account's card (Settings must be the only dialog), opens the account's access panel and checks it says the grant the server holds, then sends the same direct read through the composer and checks the reply's footer says the partial read (only part of it reached Vivid, with the account and its time), before and after reload. It removes its Connection in finally.

Still blocked: data-class switches and the PermissionDeclined card need a disposable Google account (Verify Pulse has no data classes); the ScopeRequired card has no server outcome to drive yet; Google partial consent, revoked versus expired authority and reviewed pagination need a disposable Google registration and account; phone and desktop native journeys need separate clients. Record these as blocked, never verified.

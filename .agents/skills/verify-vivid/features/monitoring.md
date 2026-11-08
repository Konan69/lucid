# Monitoring

Verify the real server entry point, with a disposable product database and native cells. Launch with an explicit private key file containing model credentials and `VIVID_VERIFY_SENTRY_DSN`, `VIVID_VERIFY_OTLP_URL` and `VIVID_VERIFY_OTLP_HEADERS`. The supervisor maps these ingest credentials into the server only and sets environment `verification`; it never receives a Sentry management token.

Run Doctor, then `verify feature monitoring <run>` with `VIVID_VERIFY_SENTRY_KEY_FILE` pointing at an explicit private file with a Sentry read token. The recipe records all RPC operation tags from `VividRpc`, calls Me successfully, stops only its own labelled disposable database, requires a public database failure, and restores that database in finally. It then asks Sentry for the actual verification error receipt. An unindexed event fails the receipt assertion; ingestion acceptance alone is not a pass.

The transport regression proves recovered HTTP failure capture, refusal filtering and privacy. Existing exporter integration checks prove real HTTP/RPC trace propagation. The mobile transport regression proves performance/session payload retention and private-data removal. These are separate claims from a real native device run.

Browser proof must use browse CLI with Helium, per the user's preference. Sign into this launch's web origin using its synthetic account, open Settings and a Thread, and retain screenshots plus the server's Sentry trace receipts. Native phone verification additionally needs action/navigation traces, a handled local Effect failure, global/React errors and a crash/relaunch receipt from a release-like binary. No desktop, iOS symbolication or alert email-delivery claim follows from server receipts. A missing native surface is blocked.

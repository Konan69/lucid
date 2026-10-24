# Error-report privacy

Model requirement: none. This feature is blocked for every SDK transport. A shared pure policy or a fabricated envelope does not prove the installed SDK's outgoing traffic.

## Behaviour and source boundaries

The shared [privacy policy](../../../../packages/client/state/src/privacy.ts) rebuilds reports from allowed fields. The SDK adapters apply it before sending and again at their transport boundary. The phone's native crash path is separate and does not pass through the JavaScript policy.

| Runtime            | Source inspected                                                                                                                                                                                                                                                                                | Missing prerequisite                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser JavaScript | [web telemetry](../../../../apps/web/src/data/telemetry.ts) starts only in a built page and wraps `makeFetchTransport`. [web scrub](../../../../apps/web/src/data/scrub.ts) filters SDK envelopes.                                                                                              | An owned ingestion destination and a genuine product error trigger with known synthetic content. The shipped DSN is a fixed production project; the recipe has no disposable transport authority or public report control. |
| Desktop renderer   | [web telemetry](../../../../apps/web/src/data/telemetry.ts) wraps `makeRendererTransport` only when the shell exposes `vivid.reporting`.                                                                                                                                                        | A packaged disposable desktop installation with reporting enabled, a real renderer error, and observation through renderer IPC to the owned destination. A plain browser or source-run shell does not start this path.     |
| Desktop main       | [main telemetry](../../../../apps/desktop/src/main/telemetry.ts) starts only for `app.isPackaged` and wraps `makeElectronOfflineTransport`. [main scrub](../../../../apps/desktop/src/main/scrub.ts) permits only the SDK's constrained process-ended message in addition to the shared policy. | A packaged disposable desktop app, a genuine main/process failure, and captured offline-delivery receipts at an owned destination. The proof stack has no packaged app or desktop SDK ingestion authority.                 |
| Phone JavaScript   | [phone telemetry](../../../../apps/mobile/src/data/telemetry.ts) starts only outside development and the web platform. [phone scrub](../../../../apps/mobile/src/data/scrub.ts) wraps `makeNativeTransport`.                                                                                    | A release phone installation, a genuine JavaScript product error, and an owned destination capturing the native transport's actual envelope. A Linux web proof cannot drive that transport.                                |
| Phone native crash | [phone telemetry](../../../../apps/mobile/src/data/telemetry.ts) enables native crash handling and documents that native reports bypass the JavaScript hooks.                                                                                                                                   | A release device, an authorized native crash/relaunch journey, and the actual native SDK's outgoing report captured at an owned destination. JavaScript scrubbing provides no proof of native crash contents.              |

## Run the mapped blocker

```sh
.agents/skills/verify-vivid/verify feature privacy flue-<id>
.agents/skills/verify-vivid/verify browser privacy flue-<id>
```

Both commands retain a blocked verdict and exit unsuccessfully. Neither emits an error report or claims a transport passed. [privacy.mjs](../scripts/privacy.mjs) owns the shared blocker reason. Root must keep privacy blocked in the final report.

## Next proof

Provision a disposable ingestion destination using a supported product configuration boundary. Do not monkey-patch SDK internals, replace transports, or send synthetic private text to the fixed production projects. Drive each SDK through its actual product error path. Capture the complete outgoing envelope and ingestion receipt. Check a known synthetic marker is absent from messages, headers, query strings, breadcrumbs, contexts, attachments, screenshots, and hierarchy data. Confirm the permitted build and stack metadata remains. Test desktop renderer and main separately, and phone native crash separately from JavaScript.

Those prerequisites require a separately scoped product or infrastructure task. This verification mapping adds no DSN switch, dependencies, simulator, server control, or product error trigger.

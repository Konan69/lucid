# Expo wire samples

`metadata.json` was produced offline by the installed `@expo/cli` 57.0.26
`build/src/export/createMetadataJson.js`, with two platform bundles and one inert image asset.
Bundle filenames and asset hashes are synthetic. The producer determines the JSON shape.

`runtime.json` was captured offline from the installed `expo-updates` 57.0.24
`utils/build/resolveRuntimeVersionAsync.js`, against this app's fixed runtime configuration,
with the managed workflow override. The CLI's `cli/build/resolveRuntimeVersion.js` prints
this result with `JSON.stringify`. `unconfigured.json` was captured from that same resolver against a disposable static app
config with no runtime version. No export, fingerprint, or provider call was needed.

`apps/server/src/updates/publishing.test.ts` runs the real publishing script in a disposable
tree with these answers. Its Expo executable only returns samples and writes inert files.
The Sentry executable is empty and the process receives no credentials.

/** Each SDK needs its actual transport and a disposable destination, beyond the shared pure policy. */
export const privacyBlocked =
  'No owned Sentry ingestion destination or genuine product error trigger is configured. Web reports only from a built page to its fixed project; desktop needs a packaged app for main/renderer IPC; phone JavaScript and native crashes need a release device. See features/privacy.md for per-SDK source and prerequisites. No SDK transport has been proved.'

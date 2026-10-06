/**
 * Sentry's additions to the phone app's Metro config (`@sentry/react-native/metro`, checked
 * against the installed SDK 8.29.0). The SDK's serializer stamps a debug ID into every bundle it
 * writes — development, an over-the-air export (`scripts/publish.mjs`) and an embedded iOS or
 * Android build alike — and writes the same ID into the map beside the bundle. Sentry pairs a
 * report's stack frames with an uploaded map by that ID, with no release or distribution name to
 * agree on, so the root script `scripts/sentry-upload.mjs` only has to upload the files.
 *
 * It also collapses Sentry's own frames in LogBox, which keeps a crash a Person shows me
 * readable. Nothing here changes what the app bundles; only the output is annotated.
 */
const { getDefaultConfig } = require('expo/metro-config')
const { withSentryConfig } = require('@sentry/react-native/metro')

const config = getDefaultConfig(__dirname)

module.exports = withSentryConfig(config)
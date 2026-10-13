import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { Option, Schema } from 'effect'
import { runningFrom, type Running } from './build'

/**
 * The phone's side of saying what it is running (`build.ts`): the app's version from its Expo
 * config, and the update from expo-updates. Both are read once, at load, because neither can
 * change while this JavaScript runs: a newer update only starts with a restart.
 */
const Versioned = Schema.Struct({ version: Schema.String })
const decodeVersioned = Schema.decodeUnknownOption(Versioned)

/**
 * The version of the JavaScript that is running, which is the one the Person is told. It comes
 * from the config the running update carries (`version` in `app.json` when it was published), so
 * it goes up with every update taken over the air. It is not the version of the installed app:
 * that one only says which native side the phone has (`runtimeVersion` in `app.json`), changes
 * only with a new install, and stayed at 0.3.1 on the developer's phone through every update,
 * which read as "the update did not arrive" (13 October 2026). None when the config has no
 * version, which a built app never is.
 */
export const version: Option.Option<string> = Option.map(
  decodeVersioned(Constants.expoConfig),
  (config) => config.version,
)

/**
 * A development build loads its JavaScript from Metro while the development launcher reports
 * updates as enabled, so it is counted as taking none, as `updating.ts` counts it.
 */
export const running: Running = runningFrom({
  enabled: Updates.isEnabled && !__DEV__,
  embedded: Updates.isEmbeddedLaunch,
  published: Option.fromNullOr(Updates.createdAt),
  id: Option.fromNullOr(Updates.updateId),
})

/** A moment with its date and its time, as this phone writes them ("6 Oct, 09:12"). */
const moment = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

/** Writes when an update was published, for `runningWords`. */
export const writeMoment = (at: Date): string => moment.format(at)

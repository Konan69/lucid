import { Schema } from 'effect'

export const Process = Schema.Struct({
  pid: Schema.Number,
  start: Schema.String,
  boot: Schema.String,
})
export const Apk = Schema.Struct({
  head: Schema.String,
  fingerprint: Schema.String,
  file: Schema.String,
  sha256: Schema.String,
  origin: Schema.String,
  mode: Schema.String,
})
/** A devbox emulator and its private adb server are captured Linux generations the run stops.
 * The PC's emulator runs on Windows and the PC's ordinary adb server sees it; the run owns
 * neither, so the receipt holds no process authority, only the serial and adb port it attached. */
export const Device = Schema.TaggedUnion({
  devbox: {
    adb: Process,
    emulator: Process,
    serial: Schema.String,
    alias: Schema.String,
    hostname: Schema.String,
    boot: Schema.String,
    sdk: Schema.String,
    avd: Schema.String,
  },
  pc: {
    serial: Schema.String,
    alias: Schema.String,
    hostname: Schema.String,
    boot: Schema.String,
    sdk: Schema.String,
    adbPort: Schema.Number,
    avd: Schema.String,
    renderer: Schema.String,
  },
})
export const Phone = Schema.Struct({
  run: Schema.String,
  stateDir: Schema.String,
  session: Schema.String,
  device: Device,
})
export const Account = Schema.Struct({
  person: Schema.String,
  email: Schema.String,
  password: Schema.String,
})

/** Decode persisted receipts once; malformed ownership cannot grant install or cleanup authority. */
export const readPhone = Schema.decodeUnknownResult(Schema.fromJsonString(Phone))
export const readDevice = Schema.decodeUnknownResult(Schema.fromJsonString(Device))
export const readApk = Schema.decodeUnknownResult(Schema.fromJsonString(Apk))
export const readAccount = Schema.decodeUnknownResult(Schema.fromJsonString(Account))

export const PhoneState = Schema.Struct({
  run: Schema.String,
  evidence: Schema.String,
  scratch: Schema.String,
  head: Schema.String,
  dirty: Schema.Boolean,
  tree: Schema.String,
  diffHash: Schema.String,
  model: Schema.String,
  modelKind: Schema.String,
  hostname: Schema.String,
  devbox: Schema.String,
  web: Schema.String,
  ports: Schema.Struct({ web: Schema.Number }),
})
export const readState = Schema.decodeUnknownResult(Schema.fromJsonString(PhoneState))

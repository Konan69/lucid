import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const DeployTargetName = Schema.Literals(["local", "preview", "production"] as const)
export type DeployTargetName = typeof DeployTargetName.Type

const DatabaseMode = Schema.Literals(["docker", "required"] as const)

const DeploymentTargetSchema = Schema.Struct({
  key: DeployTargetName,
  runnable: Schema.Boolean,
  database: DatabaseMode,
  destroyOnTeardown: Schema.Boolean,
  stackName: Schema.String,
  stage: Schema.String,
  postgresImageId: Schema.String,
  postgresVolumeName: Schema.String,
  postgresContainerName: Schema.String,
  migrationsId: Schema.String,
  serverProcessId: Schema.String,
  runtimeProcessId: Schema.String,
  webId: Schema.String,
  serverUrl: Schema.String,
  runtimeUrl: Schema.String,
  webUrl: Schema.String
})

const DeploymentTargetsSchema = Schema.Struct({
  local: DeploymentTargetSchema,
  preview: DeploymentTargetSchema,
  production: DeploymentTargetSchema
})

export type DeploymentTarget = typeof DeploymentTargetSchema.Type

/**
 * One machine-readable source keeps the Effect decoder and the plain-Node
 * offline verifier on identical target metadata without importing TypeScript.
 */
export const deploymentTargetsJson = String.raw`{
  "local": {
    "key": "local",
    "runnable": true,
    "database": "docker",
    "destroyOnTeardown": true,
    "stackName": "vivid-local",
    "stage": "local",
    "postgresImageId": "postgres-local",
    "postgresVolumeName": "vivid-postgres-local-data",
    "postgresContainerName": "vivid-postgres-local",
    "migrationsId": "migrations-local",
    "serverProcessId": "server-local",
    "runtimeProcessId": "runtime-local",
    "webId": "web-local",
    "serverUrl": "http://127.0.0.1:8787",
    "runtimeUrl": "http://127.0.0.1:5173",
    "webUrl": "http://127.0.0.1:5178"
  },
  "preview": {
    "key": "preview",
    "runnable": false,
    "database": "required",
    "destroyOnTeardown": true,
    "stackName": "vivid-preview",
    "stage": "preview",
    "postgresImageId": "postgres-preview",
    "postgresVolumeName": "vivid-postgres-preview-data",
    "postgresContainerName": "vivid-postgres-preview",
    "migrationsId": "migrations-preview",
    "serverProcessId": "server-preview",
    "runtimeProcessId": "runtime-preview",
    "webId": "web-preview",
    "serverUrl": "https://api-preview.invalid",
    "runtimeUrl": "https://runtime-preview.invalid",
    "webUrl": "https://web-preview.invalid"
  },
  "production": {
    "key": "production",
    "runnable": false,
    "database": "required",
    "destroyOnTeardown": false,
    "stackName": "vivid-production",
    "stage": "production",
    "postgresImageId": "postgres-production",
    "postgresVolumeName": "vivid-postgres-production-data",
    "postgresContainerName": "vivid-postgres-production",
    "migrationsId": "migrations-production",
    "serverProcessId": "server-production",
    "runtimeProcessId": "runtime-production",
    "webId": "web-production",
    "serverUrl": "https://api.invalid",
    "runtimeUrl": "https://runtime.invalid",
    "webUrl": "https://app.invalid"
  }
}`

export const deploymentTargets = Schema.decodeUnknownSync(
  Schema.fromJsonString(DeploymentTargetsSchema)
)(deploymentTargetsJson)

export class InvalidDeployTarget extends Schema.TaggedError<InvalidDeployTarget>()("InvalidDeployTarget", {
  variable: Schema.Literal("VIVID_DEPLOY_TARGET"),
  received: Schema.String,
  expected: Schema.String,
  message: Schema.String
}) {}

export class RemoteDeploymentDisabled extends Schema.TaggedError<RemoteDeploymentDisabled>()("RemoteDeploymentDisabled", {
  target: DeployTargetName,
  message: Schema.String
}) {}

/** Decode the external target selector and keep a misspelled target in the typed error channel. */
export const parseDeployTarget = Effect.fn("parseDeployTarget")(function*(value: string) {
  const key = yield* Schema.decodeUnknownEffect(DeployTargetName)(value).pipe(
    Effect.mapError(() => new InvalidDeployTarget({
      variable: "VIVID_DEPLOY_TARGET",
      received: value,
      expected: "local, preview, or production",
      message: `VIVID_DEPLOY_TARGET '${value}' is invalid; expected local, preview, or production`
    }))
  )
  return deploymentTargets[key]
})

/** Local is the safe default; remote targets must always be chosen explicitly. */
export const deploymentTargetFromConfig = Config.string("VIVID_DEPLOY_TARGET").pipe(
  Config.withDefault("local"),
  Effect.flatMap(parseDeployTarget)
)

/** Fail before resource registration when a disabled remote target is selected. */
export const requireRunnableTarget = Effect.fn("requireRunnableTarget")(function*(target: DeploymentTarget) {
  if (!target.runnable) {
    return yield* Effect.fail(new RemoteDeploymentDisabled({
      target: target.key,
      message: `Remote deployment target '${target.key}' is not enabled yet`
    }))
  }
  return target
})

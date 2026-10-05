# Infrastructure

2026-10-03: The current local stack below supersedes the beta.76 resource proposal preserved later in this file; current feature evidence lives in [docs/14](14-product-feature-set-and-grok-bot-parity.md).

## Current shape

```text
pnpm infra:dev
  ├─ Docker: PostgreSQL 18 → 127.0.0.1:55433
  ├─ ordered Drizzle migrations: server auth → server product
  ├─ Command.Dev: Flue runtime → 127.0.0.1:5173 (one long-lived instance)
  ├─ Command.Dev: application server → 127.0.0.1:8787
  └─ Command.Dev: Vite web proxy → 127.0.0.1:5178
```

Alchemy `2.0.0-beta.79` owns the local resources through `alchemy.run.ts`, with only Command and
Docker providers registered. There is no AWS provider or emulator in the running stack.
PostgreSQL uses database/user/password `vivid` and the named volume
`vivid-postgres-local-data`. `infra/database.ts` is the database seam and returns a `Redacted`
URL. `scripts/migrate.mjs` applies the server's auth then product chains; Flue `2.2.2` migrates
its own PostgreSQL storage when the runtime starts.

`preview` remains disabled. `production` selects `infra/railway.ts`: PostgreSQL 18, persistent
HelixDB, the private Flue runtime, and the public application server. `pnpm infra:deploy` selects
that graph; local development keeps the Command/Docker graph above. Railway PostgreSQL and
Helix were reported healthy on 3 October 2026; application deployment still needs the container
fixes and remote verification described below.

### Deploying to production

Keep the server at one Railway replica until desktop presence is shared and browse requests route to the replica holding the socket.

`pnpm infra:deploy --yes` needs `RAILWAY_API_TOKEN` for the personal Railway account, and is run
from a clean checkout of `main` so half-edited files never ship.

It reads its settings from `.env.production` in that checkout, never from `.env`. `.env` is a
developer's local file; a deploy that read it once sent production a model with no key and no
Executor key. `.env.production` is ignored by Git and holds the production values of the names in
`.env.example`; the deploy stops if the file is missing. A variable left out of the file is not
removed from a Railway service that already has it; delete it there with `railway variable delete`.

Known gap, Alchemy `2.0.0-beta.79`: the Railway provider waits about fifty seconds for a deployment
(`alchemy/src/Railway/ServiceProvider.ts`, ten tries five seconds apart), and an image build takes
about three minutes. The command therefore reports `ServiceDeployPending` and exits non-zero while
the build goes on and succeeds on Railway. Two consequences:

- Judge a deploy by Railway's deployment status and `/health`, not by the command's exit code.
- A service the tool still records as "replacing" gets one more generated public domain on every
  run, and the plan caps domains per service. After each deploy, delete every server domain except
  the first one, which `PUBLIC_URL` uses. Remove this step when the provider waits for the build.

### Before a production deploy

On 5 October 2026 two sessions ran `pnpm infra:deploy` from the same checkout one minute apart
(09:13 and 09:14 UTC), neither knowing of the other, and then both tried redeploys and rollbacks on
the Executor at once. Its old container hung in `stopping` and held the data volume, and the
Executor answered `502` for 55 minutes. No data was lost. The rules that came out of it:

- **One session deploys production.** It is the integrator named for the repository at the time.
  Every other session pushes a branch and opens a pull request; it does not run the deploy, a
  redeploy, a rollback or a Railway mutation, even to ship its own fix quickly, and even when
  production is down. If you find production broken, tell the Person and the integrator what
  you see; do not start a second repair beside theirs.
- A deploy sends everything on `main`, not only the change you came to ship. Read the plan the
  command prints (`Plan: …` and the `[Resource] update | replace | create` lines). If it touches
  a resource your change does not, find whose change that is (`git log -- infra/railway.ts`)
  before going on.
- Deploys run only from the one clean checkout that holds the Alchemy state (`.alchemy/`). A
  second checkout has no state and would create every resource again.
- The Railway CLI's session token lasts about an hour, and a deploy that outlives it fails with
  `RailwayForbidden … Not Authorized` part-way. Refresh it first (`railway whoami` with the
  personal profile) and check `user.tokenExpiresAt` in that profile's `config.json`.

### When a service with a volume will not start

Railway attaches a volume to one container at a time, so a deploy of Executor, Helix, PostgreSQL
or the runtime stops the old container before the new one starts. If the old container hangs in
`stopping`, it keeps the volume and every new deployment waits at `CREATE_CONTAINER` with no log
line until Railway fails it (about seventeen minutes), then tries again. The public address
answers `502` throughout. Redeploying or rolling back does not help: each attempt waits on the
same volume, and each new attempt cancels the one before it.

How to tell:

1. `railway ssh` into the service answers `Your service's container is not running (status:
stopping)`.
2. `railway deployment list --json`: the last deployment that worked still reads `SUCCESS` while
   newer ones sit in `DEPLOYING`. In the GraphQL API, `deploymentEvents` for a new one ends at
   `CREATE_CONTAINER` with no `completedAt`.

What to do, in this order, and only as the session that deploys:

1. Copy the volume's data off first if the service can still be reached, and keep the copy out
   of Git (it holds keys). The 5 October copy of the Executor's `/app/data` is under
   `artifacts/backup/`, which Git ignores.
2. Stop the old deployment by its id: GraphQL `mutation { deploymentStop(id: "<id>") }`.
3. If a new deployment still waits at `CREATE_CONTAINER`, move the volume to another service and
   back (`volumeInstanceUpdate`).
4. Deploy with `serviceInstanceDeployV2`. `serviceInstanceRedeploy` reuses the image of the last
   deployment, which after a rollback is the old one.

On 5 October steps 2 and 3 were both done within a minute of each other, by two sessions, so
which one released the container is not known; that is why both are listed. Between the two
volume moves the Executor ran for about three minutes with no volume, so with an empty store: it
passed `/health` and refused the server's key (`Invalid API key`). Health alone is therefore not
proof of recovery. Make one real call with the server's key (`GET
/api/organizations/<organization>/inventory`) and compare the answer with what it was: after the
recovery it was `200` and 8,914 bytes, the same as before.

Ruled out, so do not spend time on them again: the image (it pulled without credentials, and the
previous image hung the same way), the volume's own state (`READY`), the domain, the target port
and the region.

### Executor's image

Production's Executor is upstream Executor's source at commit `304bf60`, unchanged, built with
upstream's own self-host Dockerfile and published as `executor-selfhost:src-304bf60`. It was a
choice to move to current upstream source, not a requirement: adding an Integration by a
personal key was proven on the last published tag, `2.0.0-beta.8`, as well. A copy of production
data was started on the new image before the switch. The store schema and migrations are identical in both, the server's key is valid on both,
and going back to the tag is safe.

### Telemetry volume

The server exports spans and log lines to Sentry over OTLP. Export is by allowlist, and work that
repeats with nobody asking is not traced at all: timer passes (approvals, routines, push,
presence), live query reloads and session watchers run under `untraced`
(`apps/server/src/observability/quiet.ts`), and functions called once per item of a large list
are `Effect.fnUntraced`. Before those rules, one Person produced 119,000 spans an hour: 95,000
from three spans per Integration catalogue entry on every catalogue read, the rest from timers
and reloads. After a deploy, check the rate in Sentry (spans grouped by `span.name`, last hour);
a name with thousands of spans and no request behind it is a loop being traced.

## Run locally

1. Install dependencies with `pnpm install` using Node 24 or newer and pnpm `12.4.2`.
2. Start Docker.
3. Supply the application credentials below in the process environment.
4. Run `pnpm infra:verify`.
5. Run `pnpm infra:dev`.

The stack binds its processes to loopback. Remote browser or phone access needs a reachable
proxy or port forwarding. Alchemy supplies process environments; copying the root `.env.example`
is not enough because `infra/env.ts` does not load it. Its old Google redirect points at a retired
Integration route; Google account sign-in uses `/api/auth/callback/google`.

The stack currently supplies `PUBLIC_URL` as the server origin on `8787`, while people open the
web proxy on `5178`. Better Auth trusts only its configured public origin. That mismatch remains
an owner decision; this document does not claim the default proxy sign-in setup is verified.

`pnpm infra:destroy` selects only the local target and tears down Alchemy/Docker resources,
including the database volume. It is not a test cleanup command: the real local database,
Alchemy state, and runtime state are read/copy only for audits and tests. Tests require a
disposable database through `VIVID_TEST_DATABASE_URL`. Startup applies committed migrations;
Drizzle generation is a separate developer action.

### Credentials and external services

Required by the stack:

- `AUTH_SECRET` — the server requires at least 32 characters, 12 distinct characters, and 3 character classes.
- `EXPLABS_API_KEY` — the Experiential Labs model gateway.
- `VIVID_RUNTIME_TOKEN` — shared only between the application server and Flue runtime.
- `VIVID_BOAT_API_KEY` — the Boat key Vivid's Computer is reached with. A secret.
- `VIVID_BOAT_TEMPLATE` — the name of the prepared Boat template a Person's Computer is restored
  from (`infra/computer/prepare.py` prints it).
- `VIVID_PHOTON_PROJECT_ID`, `VIVID_PHOTON_PROJECT_SECRET` — the Photon project Vivid texts
  through. The secret is a secret.
- `VIVID_PUSH_VAPID_PUBLIC`, `VIVID_PUSH_VAPID_PRIVATE`, `VIVID_PUSH_SUBJECT` — the key pair and
  contact (`https:` or `mailto:`) that notifications while away are signed with. Generate the pair
  once for an environment and keep it; a new pair unsubscribes every browser and phone:

  ```sh
  node -e "const c=require('node:crypto').createECDH('prime256v1');c.generateKeys();console.log('VIVID_PUSH_VAPID_PUBLIC='+c.getPublicKey().toString('base64url'));console.log('VIVID_PUSH_VAPID_PRIVATE='+c.getPrivateKey().toString('base64url'))"
  ```

- `VIVID_EXECUTOR_KEY`, `VIVID_EXECUTOR_ORGANIZATION` — the key and organization the server uses
  on Executor, which gives Vivid its Integrations. Both are minted on the deployed Executor.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — the Google client a Person
  signs in through. They do not configure Google Integrations in Executor.

Every part of the product is required, here and in the server. The stack stops before it touches
the target and names the variable it lacks, and the server does not start without the same
settings (`requiredSetting` in `apps/server/src/config.ts`), so neither a deploy nor a running
server can be missing the Computer, memory, Integrations, texting, away notifications or Google
sign-in. `pnpm infra:verify` fails when a setting the server requires is not sent by this stack.
`VIVID_BOAT_ORG`, `VIVID_BOAT_SIZE`, `VIVID_BOAT_LIFETIME_SECONDS` and `VIVID_BOAT_MACHINE` are
forwarded to the hosted server when set (`apps/server/src/computers/README.md` says what each
does).

The runtime has one required setting of its own, `VIVID_MEMORY_DIR`, the directory of Vivid's
notes. The hosted stack sets it to a volume and the local stack to `.state/notes` beside the
runtime. `VIVID_MODEL`
defaults to `explabs/glm-5.3-flash`; pi `0.87.1` and the provider at
`packages/agent/runtime/src/providers/explabs.ts` supply model access. Vivid adds no model retry
or fallback layer. AWS credentials are not required locally.

The hosted stack runs HelixDB as a Railway service and gives the server its private address
(`VIVID_HELIX_URL`), runs Executor and gives the server its private address
(`VIVID_EXECUTOR_URL`), and gives the server the settings above. Boat and Photon are outside
services the stack does not provision. The local process graph runs none of these services and
has no stand-in for them: `Command.Dev` merges the stack's variables over the environment
`pnpm infra:dev` was started in, so a local server reads `VIVID_HELIX_URL`, `VIVID_EXECUTOR_URL`
and the rest from that environment, and does not start without them.

Outputs contain only web, server, and runtime URLs. Database and application secrets are never
outputs. Local Alchemy resources create no AWS bill, but real model calls and external services
may cost money; their charges are separate from local CPU and storage.

## Containers

Build from the repository root, one image at a time:

```sh
docker build -f apps/server/Dockerfile -t vivid-server .
docker build -f packages/agent/runtime/Dockerfile -t vivid-runtime .
```

Both images use Node 24 and the root manifest's pinned pnpm through Corepack, preserve the
installed workspace dependency layout, and run as the non-root `node` user. The server runs
`pnpm --filter @vivid/server start` (tsx); the runtime runs its built `dist/server.mjs`.
The runtime image bundles Vivid's TypeScript workspace exports into JavaScript for Node;
third-party dependencies retain Flue's external dependency layout. Local build config is unchanged.
No credential or application origin is supplied at build time. Container health checks use
`GET /health` on the configured `PORT`.

The server image defaults to `HOST=0.0.0.0`, `PORT=8787`, and
`VIVID_WEB_DIST=/app/apps/web/dist`. It builds and serves the web app on the server's origin:
API routes, WebSocket upgrades, and health retain priority; other GET/HEAD requests serve files
or the SPA document. Content-hashed assets cache immutably; the document revalidates. Traversal
and symlinks outside the static root are refused. Without `VIVID_WEB_DIST`, local startup serves
no static app; without `HOST`, it retains `127.0.0.1`. The runtime defaults to `PORT=5173` in its
image; Flue's production Node listener omits a hostname and accepts non-loopback connections.

The same image carries the mobile app's JavaScript as an over-the-air update
(`VIVID_MOBILE_UPDATES=/app/apps/mobile/updates`, exported by `apps/mobile/scripts/publish.mjs`
in the image's `updates` stage). The server answers the installed app's update check at
`/api/updates/manifest` and serves the files at `/api/updates/assets`, speaking the Expo Updates
protocol itself; no Expo service is involved. A deploy is therefore also the publish: an installed
app with the same runtime version (`version` in `apps/mobile/app.json`) downloads the new
JavaScript at its next launch. A change to native code needs a new `version` and a new binary.
Without `VIVID_MOBILE_UPDATES` the routes do not exist.

The server exports traces and logs over OpenTelemetry when `VIVID_OTLP_URL` and
`VIVID_OTLP_HEADERS` are both set, and exports nothing when neither is; one without the other
stops the launch. `VIVID_OTLP_URL` is the OTLP/HTTP base address (the server appends `/v1/traces`
and `/v1/logs`; metrics are not exported), and `VIVID_OTLP_HEADERS` is the backend's credential as
comma-separated `name=value` pairs, held as a secret. Every failure that reaches a boundary is
exported with `error.type` (the error's tag), `vivid.failure.kind` (`expected` or `defect`) and
`vivid.boundary` (`rpc`, `http`, `schedule` or `runtime`); every refusal is a `vivid.refusal`
event with `vivid.refusal.kind`. Only attributes on an allowlist leave the process, never message
text, and stdout logging is unchanged. An export gets one attempt. When one fails (a reset, a
`503`, a timeout), that signal is not exported for the next 60 seconds: what it recorded just
before the failure and during that minute never reaches the backend and is not sent later. This
is accepted, because the product must not depend on the backend. The server's stdout log on the
host keeps every line, and each gap is marked there by a `Telemetry batches dropped` line that
names the signal (`vivid.export.signal`) and the pause (`vivid.export.paused_seconds=60`). The
resource is `vivid-server`, with `VIVID_ENVIRONMENT` and `VIVID_COMMIT` when they
are set; on Railway they are filled from `RAILWAY_ENVIRONMENT_NAME` and `RAILWAY_GIT_COMMIT_SHA`,
and an empty value counts as unset. The code is
`apps/server/src/observability/`.

Supply the server with `DATABASE_URL`, `AUTH_SECRET`, `VIVID_RUNTIME_URL`,
`VIVID_RUNTIME_TOKEN`, and the externally reachable `PUBLIC_URL`. Supply the runtime with
`DATABASE_URL`, `VIVID_SERVER_URL`, the matching `VIVID_RUNTIME_TOKEN`, and `EXPLABS_API_KEY`
for model calls, and `VIVID_MEMORY_DIR` for Vivid's notes. The server also needs every setting
under "Credentials and external services": the Computer, memory, Integrations, texting, away
notifications and Google sign-in are required, and it does not start without them. Model
settings keep their defaults. Apply the auth then product
migrations before starting the server; Flue migrates its own runtime schema at startup.

Programs require the existing user-systemd/cgroup/bubblewrap/prlimit isolation. Startup probes
those prerequisites once. An ordinary container lacks them, so program runs return the existing
typed `CodeFailure.Unavailable`, and startup logs the precise `CodeIsolationUnavailable`
prerequisite. The server still starts; no alternate sandbox or unisolated program path exists.

These recipes provide packaging, not deployment resources. Alchemy remains the resource owner;
building an image neither calls Railway nor changes the local development graph.

Railway uploads the repository root through Alchemy's filtered context packer, selecting each
checked-in Dockerfile. It does not bundle an application through `main` or `extraFiles`.
Both Services pin `startCommand` to the image's `CMD`; the offline verifier rejects drift.
The runtime build also rejects external Vivid workspace imports or TypeScript file imports in
its output, and prints `Vivid workspace bundle verified for bare Node`. A deployed image must
contain that build step; an older upload of the ordinary Flue build externalizes workspace
TypeScript sources and fails under bare Node.

Server and Runtime remain independent nodes, using literal private addresses rather than each
other's resource outputs. Alchemy reconciles them concurrently and collects sibling failures;
Runtime health cannot prevent Server's build or migrations. Server's pre-deploy command runs
auth then product migrations inside its image; Runtime has no pre-deploy command. An empty
Metal scheduling log does not establish a migration or application failure: obtain the Server
deployment's detailed builder/platform error separately. Redeploy this graph with
`pnpm infra:deploy`; Dockerfile fixes land only in a new uploaded image.

## Outside the current stack

- **Computer:** the server provisions through Boat's API or an explicit local Docker adapter;
  Alchemy does not declare a Computer resource.
- **Executor:** externally configured; it is not an Alchemy resource today. Railway provisions
  HelixDB separately from the local graph.
- **Desktop:** distributed client software, not a cloud resource.
- **Artifact object storage:** Library bytes and Markdown Artifact versions stay in PostgreSQL.

## Historical beta.76 provider evaluation

The following is the earlier AWS candidate evaluation, not the current resource graph. Its
versioned inventory and deployment candidates are retained as research; recheck installed
source before using them.

## Why these resources

| Need now        | Declared resource                                         | Local implementation in beta.76                  | Decision                                                                                      |
| --------------- | --------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| PostgreSQL      | `Docker.RemoteImage`, `Docker.Volume`, `Docker.Container` | Native Docker provider                           | Use now; required PostgreSQL 18 and persistent local volume.                                  |
| Server/runtime  | `Command.Dev`                                             | Alchemy dev sidecar                              | Use now; stable localhost URLs are required by callbacks and proxies. ECS is deferred.        |
| SPA             | `AWS.Website.StaticSite`                                  | Website dev-server provider                      | Use now; in dev it runs Vite and does not create S3/CloudFront.                               |
| Migrations      | `Command.Exec`                                            | Local command provider                           | Use now; one finite command enforces the required order.                                      |
| Hosted compute  | ECS                                                       | Specialized Floci providers for Task and Service | Defer until remote deployment is enabled.                                                     |
| Object storage  | S3                                                        | Floci dual provider exists                       | Do not declare; product files and artifacts remain in Postgres.                               |
| Managed secrets | Secrets Manager/SSM                                       | Floci dual providers exist                       | Do not declare; Effect Config is the current source and duplicate secret stores add no value. |
| App Runner      | App Runner Service                                        | No dual/local registration found                 | Do not use for this local-first stack.                                                        |

The AWS Website Vite construct was considered, but beta.76 needs the optional `@alchemy.run/frontend-frameworks` package. `StaticSite` already has the required Vite dev-command behavior, so adding that dependency would provide no current value.

## What `alchemy dev` does

AWS providers in installed `alchemy@2.0.0-beta.76` select local implementations during `alchemy dev`. Floci is a persistent local AWS emulator; specialized Lambda/ECS providers can build images, watch sources, and reconcile local workloads. The website and command providers keep long-running dev processes in Alchemy's sidecar so user-code reloads do not kill them.

Provider mode is stored with each resource. Changing a resource between local and live mode is a **replacement**, not an in-place update. Registering the same resource under conflicting mode policies fails.

`Alchemy.remote()` opts a resource or Effect scope out of emulation: during `alchemy dev` it selects the live provider and can call real AWS APIs. During `alchemy deploy` everything is already live, so it changes nothing. `remote(false)` returns to the run default. This stack intentionally does not call `Alchemy.remote()`; therefore local development cannot cross into AWS.

## Exact beta.76 AWS local-provider inventory

This list is derived from `alchemy/src/AWS/Providers.ts`. The following 223 resources are registered through `flociDual(...)` or an explicit dual provider. ECS Service/Task and Lambda Function/MicrovmImage use specialized local providers rather than the generic Floci wrapper.

- **ACM:** AccountConfiguration, Certificate
- **ApiGateway:** Account, ApiKey, Authorizer, BasePathMapping, DeploymentResource, DomainName, GatewayResource, GatewayResponse, MethodResource, RestApi, StageResource, UsagePlan, UsagePlanKey, VpcLink
- **ApiGatewayV2:** Api, AuthorizerResource, DomainName, IntegrationResource, RouteResource, StageResource, VpcLink
- **AppConfig:** Application, ConfigurationProfile, Deployment, DeploymentStrategy, Environment, Extension, ExtensionAssociation, HostedConfigurationVersion
- **AppSync:** ApiAssociationResource, ApiKeyResource, DataSourceResource, DomainName, FunctionResource, GraphqlApi, ResolverResource
- **ApplicationAutoScaling:** ScalableTarget, ScalingPolicy, ScheduledAction
- **Athena:** DataCatalog, NamedQuery, PreparedStatement, WorkGroup
- **AutoScaling:** AutoScalingGroup, LaunchTemplate, LifecycleHook, ScalingPolicy, ScheduledAction
- **Batch:** ComputeEnvironment, JobDefinition, JobQueue
- **CloudFront:** CachePolicy, Distribution, Function, Invalidation, KeyGroup, KeyValueStore, KvEntries, KvRoutesUpdate, OriginAccessControl, OriginRequestPolicy, PublicKey, RealtimeLogConfig, ResponseHeadersPolicy, VpcOrigin
- **CloudMap:** HttpNamespace, InstanceRegistration, PrivateDnsNamespace, PublicDnsNamespace, Service
- **Cognito:** Group, IdentityPool, IdentityPoolRoleAttachment, IdentityProvider, ManagedLoginBranding, ResourceServer, User, UserPool, UserPoolClient, UserPoolDomain
- **DynamoDB:** Table
- **EC2:** DhcpOptions, EIP, EgressOnlyInternetGateway, FlowLog, Instance, InternetGateway, KeyPair, NatGateway, NetworkAcl, NetworkAclAssociation, NetworkAclEntry, NetworkInterface, NetworkInterfaceAttachment, PrefixList, Route, RouteTable, RouteTableAssociation, SecurityGroup, SecurityGroupRule, Snapshot, Subnet, Volume, VolumeAttachment, Vpc, VpcEndpoint, VpcPeeringConnection
- **ECR:** Image, RegistryPolicy, Repository
- **ECS:** CapacityProvider, Cluster, Service, Task, TaskDefinition
- **ELBv2:** Listener, ListenerCertificate, ListenerRule, LoadBalancer, TargetGroup, TargetGroupAttachment, TrustStore
- **EventBridge:** ApiDestination, Archive, Connection, EventBus, Permission, Rule
- **Firehose:** DeliveryStream
- **Glue:** Connection, Crawler, Database, Job, Table
- **IAM:** AccessKey, AccountAlias, AccountPasswordPolicy, Group, GroupMembership, InstanceProfile, LoginProfile, OpenIDConnectProvider, Policy, Role, SAMLProvider, SSHPublicKey, ServerCertificate, ServiceLinkedRole, ServiceSpecificCredential, SigningCertificate, User, VirtualMFADevice
- **KMS:** Alias, Key
- **Kinesis:** Stream, StreamConsumer
- **Lambda:** Alias, EventSourceMapping, Function, LayerVersion, MicrovmImage, NetworkConnector, Permission, Version
- **Logs:** Destination, LogGroup, LogStream, MetricFilter, ResourcePolicy, SubscriptionFilter
- **Pipes:** Pipe
- **RDS:** DBCluster, DBClusterEndpoint, DBClusterParameterGroup, DBInstance, DBParameterGroup, DBSubnetGroup
- **Route53:** HealthCheck, HostedZone, QueryLoggingConfig, Record, Records, VpcAssociationAuthorization, ZoneVpcAssociation
- **S3:** Bucket
- **S3Vectors:** Index, VectorBucket
- **SES:** AccountSettings, ActiveReceiptRuleSet, ConfigurationSet, ConfigurationSetEventDestination, Contact, ContactList, CustomVerificationEmailTemplate, DedicatedIpPool, EmailIdentity, EmailIdentityPolicy, EmailTemplate, MultiRegionEndpoint, ReceiptFilter, ReceiptRule, ReceiptRuleSet, Tenant, TenantResourceAssociation
- **SNS:** Subscription, Topic
- **SQS:** Queue
- **SSM:** Parameter
- **Scheduler:** Schedule, ScheduleGroup
- **SecretsManager:** RotationSchedule, Secret
- **StepFunctions:** Activity, StateMachine
- **WAFv2:** IPSet, LoggingConfiguration, RegexPatternSet, RuleGroup, WebACL, WebACLAssociation
- **Website:** AssetDeployment

`AWS.Website.Server` also has a separate local/live provider pair. `Command.Dev` and `Command.Exec` are generic Alchemy local providers, and Docker resources are mode-agnostic rather than AWS emulations.

This is API-shape evidence, not a claim of perfect AWS behavioral parity. beta.76 is pre-release software: emulator behavior, optional packages, and declaration shapes must be rechecked before enabling remote targets or upgrading Alchemy.

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

`pnpm infra:deploy --yes` needs `RAILWAY_API_TOKEN` for the personal Railway account, and is run
from a clean checkout of `main` so half-edited files never ship.

Known gap, Alchemy `2.0.0-beta.79`: the Railway provider waits about fifty seconds for a deployment
(`alchemy/src/Railway/ServiceProvider.ts`, ten tries five seconds apart), and an image build takes
about three minutes. The command therefore reports `ServiceDeployPending` and exits non-zero while
the build goes on and succeeds on Railway. Two consequences:

- Judge a deploy by Railway's deployment status and `/health`, not by the command's exit code.
- A service the tool still records as "replacing" gets one more generated public domain on every
  run, and the plan caps domains per service. After each deploy, delete every server domain except
  the first one, which `PUBLIC_URL` uses. Remove this step when the provider waits for the build.

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

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` form one optional atomic
set for account sign-in. They do not configure Google Integrations in Executor. `VIVID_MODEL`
defaults to `explabs/glm-5.3-flash`; pi `0.87.1` and the provider at
`packages/agent/runtime/src/providers/explabs.ts` supply model access. Vivid adds no model retry
or fallback layer. AWS credentials are not required locally.

The server also has adapters for Executor (`VIVID_EXECUTOR_URL`, `VIVID_EXECUTOR_KEY`), HelixDB
(`VIVID_HELIX_URL` and embedding configuration), and Boat (`VIVID_COMPUTER_PROVIDER=boat` and
Boat configuration). These services are not provisioned here, and their environment values are
not explicitly forwarded by the stack today. Check the owning adapters for their exact contract.
Boat was proven against the real service on 3 October 2026; that does not prove this stack
configures the provider. With no Computer provider or HelixDB address, those capabilities report
unavailable.

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
for model calls. Optional Google sign-in inputs remain atomic; optional provider, memory,
Executor, and model settings keep their existing contracts. Apply the auth then product
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

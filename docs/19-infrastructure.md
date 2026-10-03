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

`preview` and `production` are validated target names but fail with `RemoteDeploymentDisabled`
before resources or credentials are acquired. Their metadata declares an external database URL
for future use; neither is runnable. Nothing is deployed. There are no Neon, Railway, or
Cloudflare resources.

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

## Outside the current stack

- **Remote PostgreSQL and hosting:** topology is undecided and remote targets are disabled.
- **Computer:** the server provisions through Boat's API or an explicit local Docker adapter;
  Alchemy does not declare a Computer resource.
- **HelixDB and Executor:** externally configured services, not Alchemy resources today.
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

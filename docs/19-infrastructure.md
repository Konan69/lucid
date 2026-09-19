# Infrastructure

## Current shape

```text
pnpm infra:dev
  ├─ Docker: PostgreSQL 18 → 127.0.0.1:55433
  ├─ ordered Drizzle migrations: server → agent-runtime → connectors
  ├─ Command.Dev: agent runtime → 127.0.0.1:5173 (one long-lived instance)
  ├─ Command.Dev: server → 127.0.0.1:8787
  └─ AWS.Website.StaticSite local dev server → 127.0.0.1:5178
```

Alchemy owns all five lifecycles. PostgreSQL uses database `vivid`, user `vivid`, and password `vivid`; its data lives in the named Docker volume `vivid-postgres-local-data`. `infra/database.ts` is the only database seam and returns `DATABASE_URL` as an Effect `Redacted` value.

`preview` and `production` are validated target names, but both stop with `RemoteDeploymentDisabled` before resource registration. They still require an external `DATABASE_URL` at the database seam. Managed PostgreSQL is deliberately outside IaC until remote deployment is designed. There are no Neon, Railway, or Cloudflare resources.

## Run locally

1. Install dependencies outside this task when needed.
2. Start Docker.
3. Set the required application credentials below.
4. Run `pnpm infra:verify`.
5. Run `pnpm infra:dev`.

Use `pnpm infra:destroy` to stop this stack and remove its local Alchemy/Docker resources. It does not select a remote target. Drizzle `generate` remains a developer action; startup runs only committed migrations.

### Credentials

Required:

- `AUTH_SECRET` — at least 32 characters because the server validates it.
- `OPENROUTER_API_KEY`.
- `VIVID_RUNTIME_TOKEN`.

Optional as one atomic set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. `VIVID_MODEL` is optional and defaults to `openrouter/z-ai/glm-5.3-flash`. AWS credentials are **not** required for local development.

Outputs contain only the web, server, and runtime URLs. Database credentials and application secrets are never outputs.

Local development creates no AWS bill. Its only ongoing cost is developer-machine CPU and Docker volume storage. No estimate is claimed for remote AWS because no remote topology is enabled.

## Deliberately not in IaC yet

- **Managed PostgreSQL:** not planned. PostgreSQL is local; a remote target supplies its own `DATABASE_URL` through the one seam in `infra/database.ts`.
- **Persistent Computer machine:** the product does not provision one today; an EC2 Instance is the likely Alchemy resource after its lifecycle is decided.
- **Desktop client:** it is distributed software, not a cloud resource, so it does not belong in this stack.
- **Artifact object storage:** files remain in PostgreSQL today; an S3 Bucket can be added when the product needs object-storage semantics.
- **Remote services and web hosting:** ECS plus S3/CloudFront are candidates only after authentication URLs, networking, scaling, and teardown policy are approved.

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

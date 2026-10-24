# K8sTypes

Import `effect/cluster/K8sTypes`. Source `effect@4.0.2/src/cluster/K8sTypes.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 119. Module-name matches in Vivid: 0. No bare-name match.

## AWSElasticBlockStoreVolumeSource

Kubernetes resource types used by the cluster helpers.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:41`.

Vivid `K8sTypes.AWSElasticBlockStoreVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AWSElasticBlockStoreVolumeSource {
    fsType?: string;
    partition?: number;
    readOnly?: boolean;
    volumeID: string;
}
```

## Affinity

Affinity is a group of affinity scheduling rules.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:59`.

Vivid `K8sTypes.Affinity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Affinity {
    nodeAffinity?: NodeAffinity;
    podAffinity?: PodAffinity;
    podAntiAffinity?: PodAntiAffinity;
}
```

## AppArmorProfile

AppArmorProfile defines a pod or container's AppArmor settings.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:75`.

Vivid `K8sTypes.AppArmorProfile` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AppArmorProfile {
    localhostProfile?: string;
    type: string;
}
```

## AzureDiskVolumeSource

AzureDisk represents an Azure Data Disk mount on the host and bind mount to the pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:94`.

Vivid `K8sTypes.AzureDiskVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AzureDiskVolumeSource {
    cachingMode?: string;
    diskName: string;
    diskURI: string;
    fsType?: string;
    kind?: string;
    readOnly?: boolean;
}
```

## AzureFileVolumeSource

AzureFile represents an Azure File Service mount on the host and bind mount to the pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:116`.

Vivid `K8sTypes.AzureFileVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AzureFileVolumeSource {
    readOnly?: boolean;
    secretName: string;
    shareName: string;
}
```

## CSIVolumeSource

Represents a source location of a volume to mount, managed by an external CSI driver

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:132`.

Vivid `K8sTypes.CSIVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface CSIVolumeSource {
    driver: string;
    fsType?: string;
    nodePublishSecretRef?: LocalObjectReference;
    readOnly?: boolean;
    volumeAttributes?: {
        [name: string]: string;
    };
}
```

## Capabilities

Adds and removes POSIX capabilities from running containers.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:154`.

Vivid `K8sTypes.Capabilities` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Capabilities {
    add?: Array<string>;
    drop?: Array<string>;
}
```

## CephFSVolumeSource

Represents a Ceph Filesystem mount that lasts the lifetime of a pod Cephfs volumes do not support ownership management or SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:168`.

Vivid `K8sTypes.CephFSVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface CephFSVolumeSource {
    monitors: Array<string>;
    path?: string;
    readOnly?: boolean;
    secretFile?: string;
    secretRef?: LocalObjectReference;
    user?: string;
}
```

## CinderVolumeSource

Represents a cinder volume resource in Openstack. A Cinder volume must exist before mounting to a container. The volume must also be in the same region as the kubelet. Cinder volumes support ownership management and SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:190`.

Vivid `K8sTypes.CinderVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface CinderVolumeSource {
    fsType?: string;
    readOnly?: boolean;
    secretRef?: LocalObjectReference;
    volumeID: string;
}
```

## ClaimSource

ClaimSource describes a reference to a ResourceClaim.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:212`.

Vivid `K8sTypes.ClaimSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ClaimSource {
    resourceClaimName?: string;
    resourceClaimTemplateName?: string;
}
```

## ClusterTrustBundleProjection

ClusterTrustBundleProjection describes how to select a set of ClusterTrustBundle objects and project their contents into the pod filesystem.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:234`.

Vivid `K8sTypes.ClusterTrustBundleProjection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ClusterTrustBundleProjection {
    labelSelector?: LabelSelector;
    name?: string;
    optional?: boolean;
    path: string;
    signerName?: string;
}
```

## ConfigMapEnvSource

ConfigMapEnvSource selects a ConfigMap to populate the environment variables with.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:258`.

Vivid `K8sTypes.ConfigMapEnvSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ConfigMapEnvSource {
    name?: string;
    optional?: boolean;
}
```

## ConfigMapKeySelector

Selects a key from a ConfigMap.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:272`.

Vivid `K8sTypes.ConfigMapKeySelector` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ConfigMapKeySelector {
    key: string;
    name?: string;
    optional?: boolean;
}
```

## ConfigMapProjection

Adapts a ConfigMap into a projected volume.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:292`.

Vivid `K8sTypes.ConfigMapProjection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ConfigMapProjection {
    items?: Array<KeyToPath>;
    name?: string;
    optional?: boolean;
}
```

## ConfigMapVolumeSource

Adapts a ConfigMap into a volume.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:312`.

Vivid `K8sTypes.ConfigMapVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ConfigMapVolumeSource {
    defaultMode?: number;
    items?: Array<KeyToPath>;
    name?: string;
    optional?: boolean;
}
```

## Container

A single application container that you want to run within a pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:330`.

Vivid `K8sTypes.Container` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Container {
    args?: Array<string>;
    command?: Array<string>;
    env?: Array<EnvVar>;
    envFrom?: Array<EnvFromSource>;
    image?: string;
    imagePullPolicy?: string;
    lifecycle?: Lifecycle;
    livenessProbe?: Probe;
    name: string;
    ports?: Array<ContainerPort>;
    readinessProbe?: Probe;
    resizePolicy?: Array<ContainerResizePolicy>;
    resources?: ResourceRequirements;
    restartPolicy?: string;
    securityContext?: SecurityContext;
    startupProbe?: Probe;
    stdin?: boolean;
    stdinOnce?: boolean;
    terminationMessagePath?: string;
    terminationMessagePolicy?: string;
    tty?: boolean;
    volumeDevices?: Array<VolumeDevice>;
    volumeMounts?: Array<VolumeMount>;
    workingDir?: string;
}
```

## ContainerPort

ContainerPort represents a network port in a single container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:388`.

Vivid `K8sTypes.ContainerPort` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerPort {
    containerPort: number;
    hostIP?: string;
    hostPort?: number;
    name?: string;
    protocol?: string;
}
```

## ContainerResizePolicy

ContainerResizePolicy represents resource resize policy for the container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:408`.

Vivid `K8sTypes.ContainerResizePolicy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerResizePolicy {
    resourceName: string;
    restartPolicy: string;
}
```

## ContainerState

ContainerState holds a possible state of container. Only one of its members may be specified. If none of them is specified, the default one is ContainerStateWaiting.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:422`.

Vivid `K8sTypes.ContainerState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerState {
    running?: ContainerStateRunning;
    terminated?: ContainerStateTerminated;
    waiting?: ContainerStateWaiting;
}
```

## ContainerStateRunning

ContainerStateRunning is a running state of a container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:438`.

Vivid `K8sTypes.ContainerStateRunning` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerStateRunning {
    startedAt?: Time;
}
```

## ContainerStateTerminated

ContainerStateTerminated is a terminated state of a container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:450`.

Vivid `K8sTypes.ContainerStateTerminated` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerStateTerminated {
    containerID?: string;
    exitCode: number;
    finishedAt?: Time;
    message?: string;
    reason?: string;
    signal?: number;
    startedAt?: Time;
}
```

## ContainerStateWaiting

ContainerStateWaiting is a waiting state of a container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:474`.

Vivid `K8sTypes.ContainerStateWaiting` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerStateWaiting {
    message?: string;
    reason?: string;
}
```

## ContainerStatus

ContainerStatus contains details for the current status of this container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:488`.

Vivid `K8sTypes.ContainerStatus` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ContainerStatus {
    allocatedResources?: {
        [name: string]: Quantity;
    };
    containerID?: string;
    image: string;
    imageID: string;
    lastState?: ContainerState;
    name: string;
    ready: boolean;
    resources?: ResourceRequirements;
    restartCount: number;
    started?: boolean;
    state?: ContainerState;
    volumeMounts?: Array<VolumeMountStatus>;
}
```

## DownwardAPIProjection

Represents downward API info for projecting into a projected volume. Note that this is identical to a downwardAPI volume source without the default mode.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:530`.

Vivid `K8sTypes.DownwardAPIProjection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DownwardAPIProjection {
    items?: Array<DownwardAPIVolumeFile>;
}
```

## DownwardAPIVolumeFile

DownwardAPIVolumeFile represents information to create the file containing the pod field

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:542`.

Vivid `K8sTypes.DownwardAPIVolumeFile` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DownwardAPIVolumeFile {
    fieldRef?: ObjectFieldSelector;
    mode?: number;
    path: string;
    resourceFieldRef?: ResourceFieldSelector;
}
```

## DownwardAPIVolumeSource

DownwardAPIVolumeSource represents a volume containing downward API info. Downward API volumes support ownership management and SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:560`.

Vivid `K8sTypes.DownwardAPIVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DownwardAPIVolumeSource {
    defaultMode?: number;
    items?: Array<DownwardAPIVolumeFile>;
}
```

## EmptyDirVolumeSource

Represents an empty directory for a pod. Empty directory volumes support ownership management and SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:574`.

Vivid `K8sTypes.EmptyDirVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EmptyDirVolumeSource {
    medium?: string;
    sizeLimit?: Quantity;
}
```

## EnvFromSource

EnvFromSource represents the source of a set of ConfigMaps

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:588`.

Vivid `K8sTypes.EnvFromSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EnvFromSource {
    configMapRef?: ConfigMapEnvSource;
    prefix?: string;
    secretRef?: SecretEnvSource;
}
```

## EnvVar

EnvVar represents an environment variable present in a Container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:604`.

Vivid `K8sTypes.EnvVar` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EnvVar {
    name: string;
    value?: string;
    valueFrom?: EnvVarSource;
}
```

## EnvVarSource

EnvVarSource represents a source for the value of an EnvVar.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:620`.

Vivid `K8sTypes.EnvVarSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EnvVarSource {
    configMapKeyRef?: ConfigMapKeySelector;
    fieldRef?: ObjectFieldSelector;
    resourceFieldRef?: ResourceFieldSelector;
    secretKeyRef?: SecretKeySelector;
}
```

## EphemeralContainer

An EphemeralContainer is a temporary container that you may add to an existing Pod for user-initiated activities such as debugging. Ephemeral containers have no resource or scheduling guarantees, and they will not be restarted when they exit or when a Pod is removed or restarted. The kubelet may evict a Pod if an ephemeral container causes the Pod to exceed its resource allocation.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:642`.

Vivid `K8sTypes.EphemeralContainer` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EphemeralContainer {
    args?: Array<string>;
    command?: Array<string>;
    env?: Array<EnvVar>;
    envFrom?: Array<EnvFromSource>;
    image?: string;
    imagePullPolicy?: string;
    lifecycle?: Lifecycle;
    livenessProbe?: Probe;
    name: string;
    ports?: Array<ContainerPort>;
    readinessProbe?: Probe;
    resizePolicy?: Array<ContainerResizePolicy>;
    resources?: ResourceRequirements;
    restartPolicy?: string;
    securityContext?: SecurityContext;
    startupProbe?: Probe;
    stdin?: boolean;
    stdinOnce?: boolean;
    targetContainerName?: string;
    terminationMessagePath?: string;
    terminationMessagePolicy?: string;
    tty?: boolean;
    volumeDevices?: Array<VolumeDevice>;
    volumeMounts?: Array<VolumeMount>;
    workingDir?: string;
}
```

## EphemeralVolumeSource

Represents an ephemeral volume that is handled by a normal storage driver.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:708`.

Vivid `K8sTypes.EphemeralVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EphemeralVolumeSource {
    volumeClaimTemplate?: PersistentVolumeClaimTemplate;
}
```

## ExecAction

ExecAction describes a "run in container" action.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:730`.

Vivid `K8sTypes.ExecAction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ExecAction {
    command?: Array<string>;
}
```

## FCVolumeSource

Represents a Fibre Channel volume. Fibre Channel volumes can only be mounted as read/write once. Fibre Channel volumes support ownership management and SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:742`.

Vivid `K8sTypes.FCVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FCVolumeSource {
    fsType?: string;
    lun?: number;
    readOnly?: boolean;
    targetWWNs?: Array<string>;
    wwids?: Array<string>;
}
```

## FlexVolumeSource

FlexVolume represents a generic volume resource that is provisioned/attached using an exec based plugin.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:762`.

Vivid `K8sTypes.FlexVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FlexVolumeSource {
    driver: string;
    fsType?: string;
    options?: {
        [name: string]: string;
    };
    readOnly?: boolean;
    secretRef?: LocalObjectReference;
}
```

## FlockerVolumeSource

Represents a Flocker volume mounted by the Flocker agent. One and only one of datasetName and datasetUUID should be set. Flocker volumes do not support ownership management or SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:784`.

Vivid `K8sTypes.FlockerVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FlockerVolumeSource {
    datasetName?: string;
    datasetUUID?: string;
}
```

## GCEPersistentDiskVolumeSource

Represents a Persistent Disk resource in Google Compute Engine.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:802`.

Vivid `K8sTypes.GCEPersistentDiskVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface GCEPersistentDiskVolumeSource {
    fsType?: string;
    partition?: number;
    pdName: string;
    readOnly?: boolean;
}
```

## GRPCAction

GRPCAction specifies an action involving a gRPC service.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:820`.

Vivid `K8sTypes.GRPCAction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface GRPCAction {
    port: number;
    service?: string;
}
```

## GitRepoVolumeSource

Represents a volume that is populated with the contents of a git repository. Git repo volumes do not support ownership management. Git repo volumes support SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:844`.

Vivid `K8sTypes.GitRepoVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface GitRepoVolumeSource {
    directory?: string;
    repository: string;
    revision?: string;
}
```

## GlusterfsVolumeSource

Represents a Glusterfs mount that lasts the lifetime of a pod. Glusterfs volumes do not support ownership management or SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:860`.

Vivid `K8sTypes.GlusterfsVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface GlusterfsVolumeSource {
    endpoints: string;
    path: string;
    readOnly?: boolean;
}
```

## HTTPGetAction

HTTPGetAction describes an action based on HTTP Get requests.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:876`.

Vivid `K8sTypes.HTTPGetAction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface HTTPGetAction {
    host?: string;
    httpHeaders?: Array<HTTPHeader>;
    path?: string;
    port: number | string;
    scheme?: string;
}
```

## HTTPHeader

HTTPHeader describes a custom header to be used in HTTP probes

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:896`.

Vivid `K8sTypes.HTTPHeader` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface HTTPHeader {
    name: string;
    value: string;
}
```

## HostAlias

HostAlias holds the mapping between IP and hostnames that will be injected as an entry in the pod's hosts file.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:910`.

Vivid `K8sTypes.HostAlias` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface HostAlias {
    hostnames?: Array<string>;
    ip?: string;
}
```

## HostIP

HostIP represents a single IP address allocated to the host.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:924`.

Vivid `K8sTypes.HostIP` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface HostIP {
    ip?: string;
}
```

## HostPathVolumeSource

Represents a host path mapped into a pod. Host path volumes do not support ownership management or SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:936`.

Vivid `K8sTypes.HostPathVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface HostPathVolumeSource {
    path: string;
    type?: string;
}
```

## ISCSIVolumeSource

Represents an ISCSI disk. ISCSI volumes can only be mounted as read/write once. ISCSI volumes support ownership management and SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:950`.

Vivid `K8sTypes.ISCSIVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ISCSIVolumeSource {
    chapAuthDiscovery?: boolean;
    chapAuthSession?: boolean;
    fsType?: string;
    initiatorName?: string;
    iqn: string;
    iscsiInterface?: string;
    lun: number;
    portals?: Array<string>;
    readOnly?: boolean;
    secretRef?: LocalObjectReference;
    targetPortal: string;
}
```

## KeyToPath

Maps a string key to a path within a volume.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:982`.

Vivid `K8sTypes.KeyToPath` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface KeyToPath {
    key: string;
    mode?: number;
    path: string;
}
```

## Lifecycle

Lifecycle describes actions that the management system should take in response to container lifecycle events. For the PostStart and PreStop lifecycle handlers, management of the container blocks until the action is complete, unless the container process fails, in which case the handler is aborted.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:998`.

Vivid `K8sTypes.Lifecycle` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export interface Lifecycle {
    postStart?: LifecycleHandler;
    preStop?: LifecycleHandler;
}
```

## LifecycleHandler

LifecycleHandler defines a specific action that should be taken in a lifecycle hook. One and only one of the fields, except TCPSocket must be specified.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1012`.

Vivid `K8sTypes.LifecycleHandler` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface LifecycleHandler {
    exec?: ExecAction;
    httpGet?: HTTPGetAction;
    sleep?: SleepAction;
    tcpSocket?: TCPSocketAction;
}
```

## LocalObjectReference

LocalObjectReference contains enough information to let you locate the referenced object inside the same namespace.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1030`.

Vivid `K8sTypes.LocalObjectReference` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface LocalObjectReference {
    name?: string;
}
```

## NFSVolumeSource

Represents an NFS mount that lasts the lifetime of a pod. NFS volumes do not support ownership management or SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1042`.

Vivid `K8sTypes.NFSVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface NFSVolumeSource {
    path: string;
    readOnly?: boolean;
    server: string;
}
```

## NodeAffinity

Node affinity is a group of node affinity scheduling rules.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1058`.

Vivid `K8sTypes.NodeAffinity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface NodeAffinity {
    preferredDuringSchedulingIgnoredDuringExecution?: Array<PreferredSchedulingTerm>;
    requiredDuringSchedulingIgnoredDuringExecution?: NodeSelector;
}
```

## NodeSelector

A node selector represents the union of the results of one or more label queries over a set of nodes; that is, it represents the OR of the selectors represented by the node selector terms.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1072`.

Vivid `K8sTypes.NodeSelector` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface NodeSelector {
    nodeSelectorTerms: Array<NodeSelectorTerm>;
}
```

## NodeSelectorRequirement

A node selector requirement is a selector that contains values, a key, and an operator that relates the key and values.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1084`.

Vivid `K8sTypes.NodeSelectorRequirement` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface NodeSelectorRequirement {
    key: string;
    operator: string;
    values?: Array<string>;
}
```

## NodeSelectorTerm

A null or empty node selector term matches no objects. The requirements of them are ANDed. The TopologySelectorTerm type implements a subset of the NodeSelectorTerm.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1100`.

Vivid `K8sTypes.NodeSelectorTerm` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface NodeSelectorTerm {
    matchExpressions?: Array<NodeSelectorRequirement>;
    matchFields?: Array<NodeSelectorRequirement>;
}
```

## ObjectFieldSelector

ObjectFieldSelector selects an APIVersioned field of an object.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1114`.

Vivid `K8sTypes.ObjectFieldSelector` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ObjectFieldSelector {
    apiVersion?: string;
    fieldPath: string;
}
```

## PersistentVolumeClaimSpec

PersistentVolumeClaimSpec describes the common attributes of storage devices and allows a Source for provider-specific attributes

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1128`.

Vivid `K8sTypes.PersistentVolumeClaimSpec` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PersistentVolumeClaimSpec {
    accessModes?: Array<string>;
    dataSource?: TypedLocalObjectReference;
    dataSourceRef?: TypedObjectReference;
    resources?: VolumeResourceRequirements;
    selector?: LabelSelector;
    storageClassName?: string;
    volumeAttributesClassName?: string;
    volumeMode?: string;
    volumeName?: string;
}
```

## PersistentVolumeClaimTemplate

PersistentVolumeClaimTemplate is used to produce PersistentVolumeClaim objects as part of an EphemeralVolumeSource.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1165`.

Vivid `K8sTypes.PersistentVolumeClaimTemplate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PersistentVolumeClaimTemplate {
    metadata?: ObjectMeta;
    spec: PersistentVolumeClaimSpec;
}
```

## PersistentVolumeClaimVolumeSource

PersistentVolumeClaimVolumeSource references the user's PVC in the same namespace. This volume finds the bound PV and mounts that volume for the pod. A PersistentVolumeClaimVolumeSource is, essentially, a wrapper around another type of volume that is owned by someone else (the system).

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1179`.

Vivid `K8sTypes.PersistentVolumeClaimVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PersistentVolumeClaimVolumeSource {
    claimName: string;
    readOnly?: boolean;
}
```

## PhotonPersistentDiskVolumeSource

Represents a Photon Controller persistent disk resource.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1193`.

Vivid `K8sTypes.PhotonPersistentDiskVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PhotonPersistentDiskVolumeSource {
    fsType?: string;
    pdID: string;
}
```

## Pod

Pod is a collection of containers that can run on a host. This resource is created by clients and scheduled onto hosts.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1207`.

Vivid `K8sTypes.Pod` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export interface Pod {
    apiVersion?: "v1";
    kind?: "Pod";
    metadata?: ObjectMeta;
    spec?: PodSpec;
    readonly status?: PodStatus;
}
```

## PodAffinity

Pod affinity is a group of inter pod affinity scheduling rules.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1227`.

Vivid `K8sTypes.PodAffinity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodAffinity {
    preferredDuringSchedulingIgnoredDuringExecution?: Array<WeightedPodAffinityTerm>;
    requiredDuringSchedulingIgnoredDuringExecution?: Array<PodAffinityTerm>;
}
```

## PodAffinityTerm

Defines a set of pods (namely those matching the labelSelector relative to the given namespace(s)) that this pod should be co-located (affinity) or not co-located (anti-affinity) with, where co-located is defined as running on a node whose value of the label with key <topologyKey> matches that of any node on which a pod of the set of pods is running

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1241`.

Vivid `K8sTypes.PodAffinityTerm` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodAffinityTerm {
    labelSelector?: LabelSelector;
    matchLabelKeys?: Array<string>;
    mismatchLabelKeys?: Array<string>;
    namespaceSelector?: LabelSelector;
    namespaces?: Array<string>;
    topologyKey: string;
}
```

## PodAntiAffinity

Pod anti affinity is a group of inter pod anti affinity scheduling rules.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1263`.

Vivid `K8sTypes.PodAntiAffinity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodAntiAffinity {
    preferredDuringSchedulingIgnoredDuringExecution?: Array<WeightedPodAffinityTerm>;
    requiredDuringSchedulingIgnoredDuringExecution?: Array<PodAffinityTerm>;
}
```

## PodCondition

PodCondition contains details for the current condition of this pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1277`.

Vivid `K8sTypes.PodCondition` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodCondition {
    lastProbeTime?: Time;
    lastTransitionTime?: Time;
    message?: string;
    reason?: string;
    status: string;
    type: string;
}
```

## PodDNSConfig

PodDNSConfig defines the DNS parameters of a pod in addition to those generated from DNSPolicy.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1299`.

Vivid `K8sTypes.PodDNSConfig` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodDNSConfig {
    nameservers?: Array<string>;
    options?: Array<PodDNSConfigOption>;
    searches?: Array<string>;
}
```

## PodDNSConfigOption

PodDNSConfigOption defines DNS resolver options of a pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1315`.

Vivid `K8sTypes.PodDNSConfigOption` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodDNSConfigOption {
    name?: string;
    value?: string;
}
```

## PodIP

PodIP represents a single IP address allocated to the pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1328`.

Vivid `K8sTypes.PodIP` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodIP {
    ip?: string;
}
```

## PodOS

PodOS defines the OS parameters of a pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1340`.

Vivid `K8sTypes.PodOS` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodOS {
    name: string;
}
```

## PodReadinessGate

PodReadinessGate contains the reference to a pod condition

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1352`.

Vivid `K8sTypes.PodReadinessGate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodReadinessGate {
    conditionType: string;
}
```

## PodResourceClaim

PodResourceClaim references exactly one ResourceClaim through a ClaimSource. It adds a name to it that uniquely identifies the ResourceClaim inside the Pod. Containers that need access to the ResourceClaim reference it with this name.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1364`.

Vivid `K8sTypes.PodResourceClaim` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodResourceClaim {
    name: string;
    source?: ClaimSource;
}
```

## PodResourceClaimStatus

PodResourceClaimStatus is stored in the PodStatus for each PodResourceClaim which references a ResourceClaimTemplate. It stores the generated name for the corresponding ResourceClaim.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1378`.

Vivid `K8sTypes.PodResourceClaimStatus` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodResourceClaimStatus {
    name: string;
    resourceClaimName?: string;
}
```

## PodSchedulingGate

PodSchedulingGate is associated to a Pod to guard its scheduling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1392`.

Vivid `K8sTypes.PodSchedulingGate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodSchedulingGate {
    name: string;
}
```

## PodSecurityContext

PodSecurityContext holds pod-level security attributes and common container settings. Some fields are also present in container.securityContext. Field values of container.securityContext take precedence over field values of PodSecurityContext.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1404`.

Vivid `K8sTypes.PodSecurityContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodSecurityContext {
    appArmorProfile?: AppArmorProfile;
    fsGroup?: number;
    fsGroupChangePolicy?: string;
    runAsGroup?: number;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    seLinuxOptions?: SELinuxOptions;
    seccompProfile?: SeccompProfile;
    supplementalGroups?: Array<number>;
    sysctls?: Array<Sysctl>;
    windowsOptions?: WindowsSecurityContextOptions;
}
```

## PodSpec

PodSpec is a description of a pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1444`.

Vivid `K8sTypes.PodSpec` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodSpec {
    activeDeadlineSeconds?: number;
    affinity?: Affinity;
    automountServiceAccountToken?: boolean;
    containers: Array<Container>;
    dnsConfig?: PodDNSConfig;
    dnsPolicy?: string;
    enableServiceLinks?: boolean;
    ephemeralContainers?: Array<EphemeralContainer>;
    hostAliases?: Array<HostAlias>;
    hostIPC?: boolean;
    hostNetwork?: boolean;
    hostPID?: boolean;
    hostUsers?: boolean;
    hostname?: string;
    imagePullSecrets?: Array<LocalObjectReference>;
    initContainers?: Array<Container>;
    nodeName?: string;
    nodeSelector?: {
        [name: string]: string;
    };
    os?: PodOS;
    overhead?: {
        [name: string]: Quantity;
    };
    preemptionPolicy?: string;
    priority?: number;
    priorityClassName?: string;
    readinessGates?: Array<PodReadinessGate>;
    resourceClaims?: Array<PodResourceClaim>;
    restartPolicy?: string;
    runtimeClassName?: string;
    schedulerName?: string;
    schedulingGates?: Array<PodSchedulingGate>;
    securityContext?: PodSecurityContext;
    serviceAccount?: string;
    serviceAccountName?: string;
    setHostnameAsFQDN?: boolean;
    shareProcessNamespace?: boolean;
    subdomain?: string;
    terminationGracePeriodSeconds?: number;
    tolerations?: Array<Toleration>;
    topologySpreadConstraints?: Array<TopologySpreadConstraint>;
    volumes?: Array<Volume>;
}
```

## PodStatus

PodStatus represents information about the status of a pod. Status may trail the actual state of a system, especially if the node that hosts the pod cannot contact the control plane.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1558`.

Vivid `K8sTypes.PodStatus` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PodStatus {
    conditions?: Array<PodCondition>;
    containerStatuses?: Array<ContainerStatus>;
    ephemeralContainerStatuses?: Array<ContainerStatus>;
    hostIP?: string;
    hostIPs?: Array<HostIP>;
    initContainerStatuses?: Array<ContainerStatus>;
    message?: string;
    nominatedNodeName?: string;
    phase?: string;
    podIP?: string;
    podIPs?: Array<PodIP>;
    qosClass?: string;
    reason?: string;
    resize?: string;
    resourceClaimStatuses?: Array<PodResourceClaimStatus>;
    startTime?: Time;
}
```

## PortworxVolumeSource

PortworxVolumeSource represents a Portworx volume resource.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1608`.

Vivid `K8sTypes.PortworxVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PortworxVolumeSource {
    fsType?: string;
    readOnly?: boolean;
    volumeID: string;
}
```

## PreferredSchedulingTerm

An empty preferred scheduling term matches all objects with implicit weight 0 (i.e. it's a no-op). A null preferred scheduling term matches no objects (i.e. is also a no-op).

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1624`.

Vivid `K8sTypes.PreferredSchedulingTerm` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PreferredSchedulingTerm {
    preference: NodeSelectorTerm;
    weight: number;
}
```

## Probe

Probe describes a health check to be performed against a container to determine whether it is alive or ready to receive traffic.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1638`.

Vivid `K8sTypes.Probe` matches: 0. No qualified match. Bare-name matches: 116. Aliased usage is unverified.

```ts
export interface Probe {
    exec?: ExecAction;
    failureThreshold?: number;
    grpc?: GRPCAction;
    httpGet?: HTTPGetAction;
    initialDelaySeconds?: number;
    periodSeconds?: number;
    successThreshold?: number;
    tcpSocket?: TCPSocketAction;
    terminationGracePeriodSeconds?: number;
    timeoutSeconds?: number;
}
```

## ProjectedVolumeSource

Represents a projected volume source

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1668`.

Vivid `K8sTypes.ProjectedVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ProjectedVolumeSource {
    defaultMode?: number;
    sources?: Array<VolumeProjection>;
}
```

## QuobyteVolumeSource

Represents a Quobyte mount that lasts the lifetime of a pod. Quobyte volumes do not support ownership management or SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1682`.

Vivid `K8sTypes.QuobyteVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface QuobyteVolumeSource {
    group?: string;
    readOnly?: boolean;
    registry: string;
    tenant?: string;
    user?: string;
    volume: string;
}
```

## RBDVolumeSource

Represents a Rados Block Device mount that lasts the lifetime of a pod. RBD volumes support ownership management and SELinux relabeling.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1704`.

Vivid `K8sTypes.RBDVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface RBDVolumeSource {
    fsType?: string;
    image: string;
    keyring?: string;
    monitors: Array<string>;
    pool?: string;
    readOnly?: boolean;
    secretRef?: LocalObjectReference;
    user?: string;
}
```

## ResourceClaim

ResourceClaim references one entry in PodSpec.ResourceClaims.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1730`.

Vivid `K8sTypes.ResourceClaim` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ResourceClaim {
    name: string;
}
```

## ResourceFieldSelector

ResourceFieldSelector represents container resources (cpu, memory) and their output format

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1742`.

Vivid `K8sTypes.ResourceFieldSelector` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ResourceFieldSelector {
    containerName?: string;
    divisor?: Quantity;
    resource: string;
}
```

## ResourceRequirements

ResourceRequirements describes the compute resource requirements.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1758`.

Vivid `K8sTypes.ResourceRequirements` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ResourceRequirements {
    claims?: Array<ResourceClaim>;
    limits?: {
        [name: string]: Quantity;
    };
    requests?: {
        [name: string]: Quantity;
    };
}
```

## SELinuxOptions

SELinuxOptions are the labels to be applied to the container

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1786`.

Vivid `K8sTypes.SELinuxOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SELinuxOptions {
    level?: string;
    role?: string;
    type?: string;
    user?: string;
}
```

## ScaleIOVolumeSource

ScaleIOVolumeSource represents a persistent ScaleIO volume

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1804`.

Vivid `K8sTypes.ScaleIOVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ScaleIOVolumeSource {
    fsType?: string;
    gateway: string;
    protectionDomain?: string;
    readOnly?: boolean;
    secretRef: LocalObjectReference;
    sslEnabled?: boolean;
    storageMode?: string;
    storagePool?: string;
    system: string;
    volumeName?: string;
}
```

## SeccompProfile

SeccompProfile defines a pod/container's seccomp profile settings. Only one profile source may be set.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1834`.

Vivid `K8sTypes.SeccompProfile` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SeccompProfile {
    localhostProfile?: string;
    type: string;
}
```

## SecretEnvSource

SecretEnvSource selects a Secret to populate the environment variables with.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1858`.

Vivid `K8sTypes.SecretEnvSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SecretEnvSource {
    name?: string;
    optional?: boolean;
}
```

## SecretKeySelector

SecretKeySelector selects a key of a Secret.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1872`.

Vivid `K8sTypes.SecretKeySelector` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SecretKeySelector {
    key: string;
    name?: string;
    optional?: boolean;
}
```

## SecretProjection

Adapts a secret into a projected volume.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1892`.

Vivid `K8sTypes.SecretProjection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SecretProjection {
    items?: Array<KeyToPath>;
    name?: string;
    optional?: boolean;
}
```

## SecretVolumeSource

Adapts a Secret into a volume.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1912`.

Vivid `K8sTypes.SecretVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SecretVolumeSource {
    defaultMode?: number;
    items?: Array<KeyToPath>;
    optional?: boolean;
    secretName?: string;
}
```

## SecurityContext

SecurityContext holds security configuration that will be applied to a container. Some fields are present in both SecurityContext and PodSecurityContext. When both are set, the values in SecurityContext take precedence.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1930`.

Vivid `K8sTypes.SecurityContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SecurityContext {
    allowPrivilegeEscalation?: boolean;
    appArmorProfile?: AppArmorProfile;
    capabilities?: Capabilities;
    privileged?: boolean;
    procMount?: string;
    readOnlyRootFilesystem?: boolean;
    runAsGroup?: number;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    seLinuxOptions?: SELinuxOptions;
    seccompProfile?: SeccompProfile;
    windowsOptions?: WindowsSecurityContextOptions;
}
```

## ServiceAccountTokenProjection

ServiceAccountTokenProjection represents a projected service account token volume. This projection can be used to insert a service account token into the pods runtime filesystem for use against APIs (Kubernetes API Server or otherwise).

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1964`.

Vivid `K8sTypes.ServiceAccountTokenProjection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ServiceAccountTokenProjection {
    audience?: string;
    expirationSeconds?: number;
    path: string;
}
```

## SleepAction

SleepAction describes a "sleep" action.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1980`.

Vivid `K8sTypes.SleepAction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SleepAction {
    seconds: number;
}
```

## StorageOSVolumeSource

Represents a StorageOS persistent volume resource.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:1992`.

Vivid `K8sTypes.StorageOSVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StorageOSVolumeSource {
    fsType?: string;
    readOnly?: boolean;
    secretRef?: LocalObjectReference;
    volumeName?: string;
    volumeNamespace?: string;
}
```

## Sysctl

Sysctl defines a kernel parameter to be set

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2012`.

Vivid `K8sTypes.Sysctl` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Sysctl {
    name: string;
    value: string;
}
```

## TCPSocketAction

TCPSocketAction describes an action based on opening a socket

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2026`.

Vivid `K8sTypes.TCPSocketAction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TCPSocketAction {
    host?: string;
    port: number | string;
}
```

## Toleration

The pod this Toleration is attached to tolerates any taint that matches the triple <key,value,effect> using the matching operator <operator>.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2040`.

Vivid `K8sTypes.Toleration` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Toleration {
    effect?: string;
    key?: string;
    operator?: string;
    tolerationSeconds?: number;
    value?: string;
}
```

## TopologySpreadConstraint

TopologySpreadConstraint specifies how to spread matching pods among the given topology.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2060`.

Vivid `K8sTypes.TopologySpreadConstraint` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TopologySpreadConstraint {
    labelSelector?: LabelSelector;
    matchLabelKeys?: Array<string>;
    maxSkew: number;
    minDomains?: number;
    nodeAffinityPolicy?: string;
    nodeTaintsPolicy?: string;
    topologyKey: string;
    whenUnsatisfiable: string;
}
```

## TypedLocalObjectReference

TypedLocalObjectReference contains enough information to let you locate the typed referenced object inside the same namespace.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2115`.

Vivid `K8sTypes.TypedLocalObjectReference` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TypedLocalObjectReference {
    apiGroup?: string;
    kind: string;
    name: string;
}
```

## TypedObjectReference

TypedObjectReference contains enough information to locate a typed referenced object.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2131`.

Vivid `K8sTypes.TypedObjectReference` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TypedObjectReference {
    apiGroup?: string;
    kind: string;
    name: string;
    namespace?: string;
}
```

## Volume

Volume represents a named volume in a pod that may be accessed by any container in the pod.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2149`.

Vivid `K8sTypes.Volume` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Volume {
    awsElasticBlockStore?: AWSElasticBlockStoreVolumeSource;
    azureDisk?: AzureDiskVolumeSource;
    azureFile?: AzureFileVolumeSource;
    cephfs?: CephFSVolumeSource;
    cinder?: CinderVolumeSource;
    configMap?: ConfigMapVolumeSource;
    csi?: CSIVolumeSource;
    downwardAPI?: DownwardAPIVolumeSource;
    emptyDir?: EmptyDirVolumeSource;
    ephemeral?: EphemeralVolumeSource;
    fc?: FCVolumeSource;
    flexVolume?: FlexVolumeSource;
    flocker?: FlockerVolumeSource;
    gcePersistentDisk?: GCEPersistentDiskVolumeSource;
    gitRepo?: GitRepoVolumeSource;
    glusterfs?: GlusterfsVolumeSource;
    hostPath?: HostPathVolumeSource;
    iscsi?: ISCSIVolumeSource;
    name: string;
    nfs?: NFSVolumeSource;
    persistentVolumeClaim?: PersistentVolumeClaimVolumeSource;
    photonPersistentDisk?: PhotonPersistentDiskVolumeSource;
    portworxVolume?: PortworxVolumeSource;
    projected?: ProjectedVolumeSource;
    quobyte?: QuobyteVolumeSource;
    rbd?: RBDVolumeSource;
    scaleIO?: ScaleIOVolumeSource;
    secret?: SecretVolumeSource;
    storageos?: StorageOSVolumeSource;
    vsphereVolume?: VsphereVirtualDiskVolumeSource;
}
```

## VolumeDevice

volumeDevice describes a mapping of a raw block device within a container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2236`.

Vivid `K8sTypes.VolumeDevice` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VolumeDevice {
    devicePath: string;
    name: string;
}
```

## VolumeMount

VolumeMount describes a mounting of a Volume within a container.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2250`.

Vivid `K8sTypes.VolumeMount` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VolumeMount {
    mountPath: string;
    mountPropagation?: string;
    name: string;
    readOnly?: boolean;
    recursiveReadOnly?: string;
    subPath?: string;
    subPathExpr?: string;
}
```

## VolumeMountStatus

VolumeMountStatus shows status of volume mounts.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2286`.

Vivid `K8sTypes.VolumeMountStatus` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VolumeMountStatus {
    mountPath: string;
    name: string;
    readOnly?: boolean;
    recursiveReadOnly?: string;
}
```

## VolumeProjection

Projection that may be projected along with other supported volume types

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2304`.

Vivid `K8sTypes.VolumeProjection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VolumeProjection {
    clusterTrustBundle?: ClusterTrustBundleProjection;
    configMap?: ConfigMapProjection;
    downwardAPI?: DownwardAPIProjection;
    secret?: SecretProjection;
    serviceAccountToken?: ServiceAccountTokenProjection;
}
```

## VolumeResourceRequirements

VolumeResourceRequirements describes the storage resource requirements for a volume.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2334`.

Vivid `K8sTypes.VolumeResourceRequirements` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VolumeResourceRequirements {
    limits?: {
        [name: string]: Quantity;
    };
    requests?: {
        [name: string]: Quantity;
    };
}
```

## VsphereVirtualDiskVolumeSource

Represents a vSphere volume resource.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2352`.

Vivid `K8sTypes.VsphereVirtualDiskVolumeSource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VsphereVirtualDiskVolumeSource {
    fsType?: string;
    storagePolicyID?: string;
    storagePolicyName?: string;
    volumePath: string;
}
```

## WeightedPodAffinityTerm

The weights of all of the matched WeightedPodAffinityTerm fields are added per-node to find the most preferred node(s)

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2370`.

Vivid `K8sTypes.WeightedPodAffinityTerm` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface WeightedPodAffinityTerm {
    podAffinityTerm: PodAffinityTerm;
    weight: number;
}
```

## WindowsSecurityContextOptions

WindowsSecurityContextOptions contain Windows-specific options and credentials.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2384`.

Vivid `K8sTypes.WindowsSecurityContextOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface WindowsSecurityContextOptions {
    gmsaCredentialSpec?: string;
    gmsaCredentialSpecName?: string;
    hostProcess?: boolean;
    runAsUserName?: string;
}
```

## FieldsV1

FieldsV1 stores a set of fields in a data structure like a Trie, in JSON format.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2408`.

Vivid `K8sTypes.FieldsV1` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FieldsV1 {
}
```

## LabelSelector

A label selector is a label query over a set of resources. The result of matchLabels and matchExpressions are ANDed. An empty label selector matches all objects. A null label selector matches no objects.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2418`.

Vivid `K8sTypes.LabelSelector` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface LabelSelector {
    matchExpressions?: Array<LabelSelectorRequirement>;
    matchLabels?: {
        [name: string]: string;
    };
}
```

## LabelSelectorRequirement

A label selector requirement is a selector that contains values, a key, and an operator that relates the key and values.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2434`.

Vivid `K8sTypes.LabelSelectorRequirement` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface LabelSelectorRequirement {
    key: string;
    operator: string;
    values?: Array<string>;
}
```

## ManagedFieldsEntry

ManagedFieldsEntry is a workflow-id, a FieldSet and the group version of the resource that the fieldset applies to.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2450`.

Vivid `K8sTypes.ManagedFieldsEntry` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ManagedFieldsEntry {
    apiVersion?: string;
    fieldsType?: string;
    fieldsV1?: FieldsV1;
    manager?: string;
    operation?: string;
    subresource?: string;
    time?: Time;
}
```

## ObjectMeta

ObjectMeta is metadata that all persisted resources must have, which includes all objects users must create.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2474`.

Vivid `K8sTypes.ObjectMeta` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ObjectMeta {
    annotations?: {
        [name: string]: string;
    };
    readonly creationTimestamp?: Time;
    readonly deletionGracePeriodSeconds?: number;
    readonly deletionTimestamp?: Time;
    finalizers?: Array<string>;
    generateName?: string;
    readonly generation?: number;
    labels?: {
        [name: string]: string;
    };
    managedFields?: Array<ManagedFieldsEntry>;
    name?: string;
    namespace?: string;
    ownerReferences?: Array<OwnerReference>;
    readonly resourceVersion?: string;
    selfLink?: string;
    readonly uid?: string;
}
```

## OwnerReference

OwnerReference contains enough information to let you identify an owning object. An owning object must be in the same namespace as the dependent, or be cluster-scoped, so there is no namespace field.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2556`.

Vivid `K8sTypes.OwnerReference` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface OwnerReference {
    apiVersion: string;
    blockOwnerDeletion?: boolean;
    controller?: boolean;
    kind: string;
    name: string;
    uid: string;
}
```

## Time

Time is a wrapper around time.Time which supports correct marshaling to YAML and JSON. Wrappers are provided for many of the factory methods that the time package offers.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2578`.

Vivid `K8sTypes.Time` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export type Time = string;
```

## Quantity

Quantity is a fixed-point representation of a number. It provides convenient marshaling/unmarshaling in JSON and YAML, in addition to String() and AsInt64() accessors.

Source: `effect@4.0.2/src/cluster/K8sTypes.ts:2587`.

Vivid `K8sTypes.Quantity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type Quantity = string;
```

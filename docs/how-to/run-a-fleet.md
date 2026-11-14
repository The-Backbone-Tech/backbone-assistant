# Run many data folders from one place

The Helm chart runs the existing [Linux daemon image](../../deploy/docker/Dockerfile).
Each data folder has a single-replica StatefulSet and a retained ReadWriteOnce claim. Use a
block-backed storage class with a local ext4 or XFS filesystem. NFS, overlay and
unknown filesystems are refused by the experimental Linux data folder lock. ReadWriteOnce
alone does not exclude two writers on the same node; the data folder lock does.

This is an experimental deployment path. Linux data folder locking still needs Linux
qualification. The runtime test below is the acceptance gate for your cluster and
image; rendering alone does not establish a working fleet.

## Install

**Trial limitation:** the current holder keeps the data key in plaintext at
/data/home/keys/vault.json, and a cold archive includes it. This is a headless trial,
not a protected production key holder. Set trial.plaintextKeysAcknowledged to true
only after accepting that limitation. The schema refuses an unacknowledged install.
The product has no Kubernetes Secret or KMS holder yet; see the
[deployment contract](../../deploy/helm/backbone/CONTRACT.md).

You need Helm, Kubernetes 1.30 or newer, cluster permission to install a
ValidatingAdmissionPolicy and binding, a policy-capable CNI, encrypted-at-rest block
storage and a registry your cluster can pull from. Confirm the storage provider's
encryption and access controls for both data folder and backup storage. Set
storage.encryptionConfirmed and backups.encryptionConfirmed to true after checking;
these acknowledgements do not detect encryption. Set both className values and
sizes explicitly. Each data folder receives a separate retained backup claim, never an
archive directory on its data folder claim. Use a separate protected storage pool or
failure domain for backups; separate claims alone do not protect against disk loss. Build the existing Dockerfile,
push it to your registry, then record the immutable repository digest. The image
runs Pi with your model endpoint; it does not contain signed-in desktop clients.

Copy [the values file](../../deploy/helm/backbone/values.yaml) to values.yaml. It is
JSON, which is valid YAML; ordinary YAML works too. Replace the placeholder image
digest, choose storage, and list each data folder with its modelRoute.endpoint,
modelRoute.model and policy. Set namespace.name to the install namespace and keep
namespace.dedicated true and namespace.podSecurity baseline. A dedicated namespace
is required because backup workers read every data folder's data; do not place unrelated
workloads or secrets there. The chart applies Pod Security baseline. It cannot use
restricted while the policy-copy init container needs root and CHOWN.
The lifecycle Role can only read and scale named data folder StatefulSets, read/delete
their named pods, and inspect/delete their named backup Jobs. Kubernetes cannot
scope Job creation by resourceNames, so a fail-closed admission policy admits only
the fixed backup template, image, mounts and claims for the rollout identity.
Home and backup containers have no API token. The ServiceAccount disables automatic
tokens; only the two API hook pods explicitly opt in. The chart avoids fsGroup recursion,
which could change existing private key and persistent lock-file permissions;
the init container gives uid 1000 ownership of new data folder and backup directories only. Credentials do not belong in values;
use a credential-free local endpoint or provision a data folder's credentials separately.
The endpoint schema refuses userinfo, query strings and fragments. An existing
saved model route takes precedence over the endpoint fallback.

NetworkPolicy denies all ingress and egress by default. Homes can query kube-dns;
add only needed model-provider IPv4 CIDR/port pairs to network.modelEgress.
Hooks can query DNS and contact network.apiServerCidrs on TCP 443 or 6443. Supply
both the Kubernetes service IP and API endpoint addresses as /32 entries when your
CNI sees both sides of service translation. Default model egress is empty. DNS
and API topology must match your cluster; this chart currently supports IPv4
rules. The CNI must enforce NetworkPolicy. No service exposes the daemon.
All containers have read-only root filesystems, dropped capabilities and
RuntimeDefault seccomp. PostgreSQL's writable native library copy and temporary
files live in bounded emptyDirs. Root init containers keep only CHOWN; they never
recursively change an existing data folder.

The policy object carries policy and trust as UTF-8 text under managed-policy.json
and policy-trust.json. Put the raw 64-byte Ed25519 signature in managed-policy.json.sig
as base64: the chart uses ConfigMap binaryData so the mounted permission keeps its
original binary bytes. Leave all three empty for unmanaged
data folders. The init container copies them from the projected ConfigMap into a separate
emptyDir at /etc/backbone, with regular files owned by uid 0 and mode 0644, beneath
a root-owned 0755 directory. The daemon mounts that directory read-only. Policy
bytes are configuration, not secrets; Helm stores values in its permission history.
C8 is not integrated at this base: delivery is implemented, enforcement is pending.
When it lands, enable a signed-policy runtime fixture and require the installed
reader's verified status for these exact mounted files, plus tamper and expiry
refusals. Do not claim that today's placeholder policy is verified.

```bash
helm lint deploy/helm/backbone -f values.yaml
helm install fleet deploy/helm/backbone -n fleet --create-namespace -f values.yaml --timeout 30m
kubectl get statefulsets,pods -n fleet
```

The timeout examples suit a small fleet; increase Helm’s timeout for the number
of data folders and your rollout.timeoutSeconds bound. Every data folder must show Ready. Readiness invokes the existing doctor command with
JSON output and requires a live daemon and successful holder inspection. It does
not start a second daemon or wait for the future F7 implementation. Doctor's
current read-only limits apply. Read the per-pod container image to see its version.

## Upgrade and recover

Keep the same Helm release name and data folder names. Change the image digest in values.yaml:

```bash
helm upgrade fleet deploy/helm/backbone -n fleet -f values.yaml --timeout 30m
```

Before applying templates, the pre-upgrade hook visits installed data folders in name
order. For each one it stops the StatefulSet, waits for its pod to disappear,
exports the person's work with the **old image**, and takes and checks a cold tar
archive of the full data folder (including its plaintext keys). The raw archive holds
the existing data folder lock; the CLI has finished and closed Core before it takes that
lock, so a competing writer refuses the backup instead of racing its bytes. It restarts the old data folder
before proceeding. Archives and exports go to /backups/archives/revision-N on the
separate release-home-backups claim, which live data folders cannot mount. The writable
data folder remains /data/home. backups.retention.maxArchives bounds completed archives
(default three). After a successful, checked archive, older completed directories
are pruned. Incomplete or unknown outcomes are retained for investigation and can
still fill the backup claim; inspect and resolve them before retrying. Replicate
backups to protected independent storage before deleting retained claims.
The plain export is portable; the cold archive is an operator recovery copy and
must be treated as secret. Neither backup gives permission new.

The post-upgrade hook replaces pods one at a time using OnDelete, waiting for the
requested controller revision and doctor readiness before moving to the next data folder.
A failed backup or readiness fails the Helm operation. There are no automatic Job
retries. Later data folders keep their previous pods. Keep all data folders in values: removing
a data folder deletes its StatefulSet but retains its claim. Storage class and initial
claim size cannot be changed through a StatefulSet upgrade.

Inspect the failed hook Job and pod logs. To restore the previous image and config:

```bash
helm history fleet -n fleet
helm rollback fleet 1 -n fleet --timeout 30m
kubectl get pods -n fleet
```

Use the successful revision from history instead of 1 when appropriate. Do not use
--wait on upgrade or rollback: Helm can otherwise wait for the failed old pod before
the post hook can replace it. The hooks themselves wait for Ready and Helm waits
for hook Jobs. Do not use --no-hooks, --force or automatic rollback for this journey. Rollback uses the same
serial replacement hook, including replacement of a failed pod, and preserves the
existing data folder data and human edits. It restores image and configuration, not old
database bytes. A version that makes an incompatible data migration needs its own
restore procedure using the cold archive; this chart cannot reverse arbitrary
migrations. Inspect unknown outcome receipts before doing work again.

If a hook is interrupted, inspect its backup Job before restarting any data folder. An
active or unconfirmed backup leaves that data folder stopped to avoid a second writer.
After confirming the backup process has ended, scale that StatefulSet to one and
wait for Ready. Do not blindly repeat a failed backup Job: the existing Job and exclusive revision
export directory deliberately refuse a repeat. Retain the failed Job and logs
until its outcome is understood. After resolving a terminal failure and saving
logs, delete only the inspected release-home-backup Job before a new Helm revision.
Never delete an active or unconfirmed backup worker; leave that data folder stopped until
its ownership is resolved.
Runtime scripts use content-named ConfigMaps, so a chart update cannot replace the
probe code of an unchanged pod. Hook runtime ConfigMaps are retained by Helm; after
uninstall and after confirming no pods use them, remove the permission’s runtime
ConfigMaps explicitly (label app.kubernetes.io/component=runtime).

## A lighter Compose fleet

[The Compose fleet](../../deploy/compose/fleet.yaml) has two example data folders. Copy a
service and add distinct external data folder and backup volumes and a private network for
each additional data folder. Pre-provision the external data folder volume's /data directory for
uid 1000 with mode 0700 on encrypted block storage; the Compose service has no root
init container. Set BACKBONE_ALPHA_HOME_VOLUME, BACKBONE_BETA_HOME_VOLUME,
BACKBONE_ALPHA_BACKUP_VOLUME and BACKBONE_BETA_BACKUP_VOLUME to those distinct
volumes. Set BACKBONE_PLAINTEXT_TRIAL_ACK to
I_ACCEPT_PLAINTEXT_KEYS_ON_THE_DATA_VOLUME and BACKBONE_ENCRYPTED_STORAGE_ACK to
I_CONFIRMED_ENCRYPTED_VOLUMES after checking the storage. Set
BACKBONE_FLEET_IMAGE to the built repository and BACKBONE_FLEET_DIGEST to its sha256
digest. Configure endpoint/model environment per service when they differ. Start:

```bash
docker compose -f deploy/compose/fleet.yaml up -d --wait
```

If Compose is installed as a standalone binary, use docker-compose in place of
docker compose. Both accept the same fleet file. Compose runs uid 1000 with a read-only root,
dropped capabilities, no-new-privileges and Docker's default seccomp profile.
Each data folder has an internal network with no outside egress. Attach an explicitly
protected model gateway to that network, or use a network override with host
firewall rules limiting provider egress. Compose has no native CIDR NetworkPolicy.

Compose supplies isolated data folders and doctor health checks. For upgrades, stop one
service, set umask 077, and mount its external data folder volume plus a separate protected
backup volume in a disposable container using the old image. Export to that backup
volume, close Core, and take a cold archive under the data folder lock (the chart's backup
helper follows this ordering). Keep only the intended completed archives after
copying them to protected independent storage. Recreate the service with the new digest, and
wait for its health before touching the next. Keep the previous digest for recovery.
Compose does not run Helm's serial rollout hooks. Policy delivery in this file is
not configured; bind only regular, protected root-owned files if you add it.

## Check the chart and the journey

This headless step uses disposable temporary state, no account and no cluster:

```bash test
node --test scripts/fleet-chart.test.mjs scripts/fleet-lifecycle.test.mjs scripts/fleet-backup.test.mjs scripts/fleet-security.test.mjs
```

With Helm installed this includes actual template rendering and schema rejection.
Without it, schema, Compose and lifecycle properties still run and rendering is
reported unavailable. Set BACKBONE_FLEET_REQUIRE_HELM=1 to require rendering.

The runtime test creates its own kind cluster and namespace, two disposable data folders,
and three local images. It checks Ready data folders, an upgrade preserving a pre-existing
thread, root-owned regular policy files, a competing writer's refusal, and a
failed probe followed by rollback. It also checks named RBAC, server-side admission
refusals, read-only roots and separate backup storage. kindnet does not enforce
NetworkPolicy packet filtering: the test checks live policy resources only. Its
local-path storage is disposable and unencrypted; the fixture acknowledgements
exercise schema plumbing, not storage-provider encryption. It needs Docker running, kind, kubectl, Helm,
and registry network access for base images. It never uses a real data folder.
Run under the supplied shared heavy-test lock (also required for pnpm check).
Save stdout and stderr under an ignored evidence directory for review:

```bash
mkdir -p evidence/fleet
# Set HEAVY_LOCK_WRAPPER to the supplied with-heavy-lock.sh path.
bash "$HEAVY_LOCK_WRAPPER" "fleet runtime" env BACKBONE_FLEET_RUNTIME=1 node --test scripts/fleet-runtime.test.mjs > evidence/fleet/runtime.log 2>&1
```

It removes its own cluster and test images on completion. Runtime failures are
failures, never converted to skipped tests. The light tests exercise the lifecycle
against a local Kubernetes API double as well; those do not qualify Linux locking,
PostgreSQL on the target volume, or C8 verification.

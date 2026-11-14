# Fleet deployment contract

An operator installs a digest-pinned Linux daemon image into a dedicated namespace.
Each home has one StatefulSet replica and its own retained RWO data claim. Doctor
readiness gates serial replacement. Pre-upgrade workers stop each old home, export
with its old image, close Core, then lock and archive the home to a separate retained
backup claim. A failed readiness stops later replacements; Helm rollback restores
the previous image and configuration, preserving existing data and human edits.
Arbitrary database migrations are not reversed by rollback.

This is an experimental headless trial. The product's available protected holder
uses an OS keychain; it has no file-key or environment-provided wrapping-key holder
that this chart can mount. Plaintext keys remain on the data volume and in archives.
The schema requires explicit trial acknowledgement and operator confirmation of
encrypted, access-controlled home and backup storage. Acknowledgements are not
attestations from a storage provider. Backups require their own claims and should
use a separate storage pool or failure domain. Completed archive retention is
bounded; incomplete outcomes are preserved until inspected. Neither volume
separation nor filesystem permissions stop a cluster administrator reading keys.

Named follow-up: **Kubernetes Secret or KMS key holder**. This requires a product
holder that keeps the data key off the home volume, and an archive exclusion or
rewrapping policy. It must precede any protected non-experimental deployment claim.
This unit does not implement that holder or edit the product's key contracts.

Kubernetes and Helm are the deployment engines (Apache-2.0); no operator or rollout
framework is added. Kubernetes 1.30+ admission policy confines the rollout identity's
otherwise unscopable Job-create permission to the backup template and named claims.
The namespace must be dedicated and enforce Pod Security baseline. Root init
containers retain only CHOWN; all containers use read-only roots and RuntimeDefault
seccomp. A policy-capable CNI must enforce the default-deny network policies;
model egress and API CIDRs are explicit IPv4 configuration. kindnet's acceptance
run establishes the policy resources, not packet-filter enforcement. Protected
storage encryption and a policy-capable target cluster remain operator checks.

Policy delivery copies projected configuration into regular root-owned files under
/etc/backbone; the home sees a read-only mount. C8 is not integrated at this base.
Follow-up **C8 installed policy verification**: assert the installed reader consumes
this exact path, require verified status for the mounted signature bytes, and test
tamper and expiry refusal. Until then no policy enforcement claim is made. The
current doctor is used directly; no dependency on F7 changes is introduced.

Chart 0.1 backups were on each home claim. Before upgrading such an installation,
stop and migrate its archives to the new protected backup claims, pre-provision
those claims, and verify their ownership/access before invoking the 0.2 pre-upgrade
hook. The automatic acceptance journey starts from 0.2; no in-place 0.1 storage
migration is claimed. Keep release/home names stable and all homes in values.
Retained claims, namespaces and content-named runtime ConfigMaps require deliberate
cleanup after confirming no process still uses them.

The light tests are scripts/fleet-chart.test.mjs, scripts/fleet-security.test.mjs,
scripts/fleet-backup.test.mjs and scripts/fleet-lifecycle.test.mjs. The opt-in
scripts/fleet-runtime.test.mjs owns a disposable kind cluster and proves Ready,
pre-existing thread survival, lock exclusion, real policy file ownership,
admission refusals, backup separation and failed-probe rollback. Run it with
BACKBONE_FLEET_RUNTIME=1 under the shared heavy wrapper and retain its output in
ignored evidence. Every test owns its temporary state.

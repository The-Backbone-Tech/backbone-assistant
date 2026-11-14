# Manage data folders with a policy

Use a managed machine's protected system directory to apply the same policy to
every data folder, including newly created data folders. The [contract](../contracts/managed-policy.md)
defines every key, precedence, sources, trust and threat model. The Host, vault,
connector and Settings integrations are applied; the contract
is retained as history.

## Prepare offline

Write JSON with id, positive monotonic version, requirements and defaults. Optional
notAfter is a UTC date such as 2027-01-01T00:00:00Z. Optional scope.machine matches
the operating-system hostname; scope.organisation matches protected trust.
Requirements restrict; defaults choose only when the person chose nothing.
Unknown requirements refuse; unknown defaults warn. A known field this build
cannot enforce everywhere refuses in either section, with “not enforceable in
this build”. The enforcement table is currently empty: every listed requirement
has product enforcement. A default cannot choose plaintext
keys or unrestricted ACP rights.

Use the current-build example in the contract, adjusting its route providers
and collector endpoint. Never include secrets. A
required telemetry endpoint should have a complete traces path. Requirements do
not create credentials, approve a permission or opt in to content export.

Generate an offline Ed25519 signing key with Node's crypto or an approved standard
key tool. Keep it outside all data folders and outside the installation; distribute only
the public key. Sign the exact bytes (formatting changes require signing again):

```sh
node scripts/sign-managed-policy.mjs policy.json offline-private.pem > policy-trust.json
```

The script creates policy.json.sig and prints public keys, policy id, the version
floor and the active SHA-256 digest. Add organisation to trust when using that
scope. Rename policy.json and its companion to managed-policy.json and
managed-policy.json.sig for deployment. Review the trust output before installing.
The script does not install anything, preserve an earlier floor or rotate keys.

## Install with the administrator's deployment tools

Use /Library/Application Support/backbone on macOS, /etc/backbone on Linux,
and C:/ProgramData/backbone on Windows. Protect policy-trust.json, the policy,
its signature and every ancestor from ordinary-user writes. POSIX paths must be
root-owned, with no group or other write bits, no symlinks and no macOS extended
ACLs. Windows refuses a present policy until its ACL verifier is qualified.
This is not Windows managed-policy support. An ordinary Windows user can create
that directory and cause other users to refuse startup. Reserve its path with an
administrator ACL during installation before allowing first launch.

Install trust and the detached signature before replacing the policy file using
an atomic rename. All intermediate incomplete or mismatched deployments refuse;
coordinate a maintenance window. Never temporarily remove all three artifacts:
that means an unmanaged machine. The runtime writes no machine-wide version state.
The deployment record owns it and must survive deletion of any personal data folder.

For an update, increase version and preserve the prior high-water mark. For a
lower-version rollback, set rollbackOf to that high-water version, sign it and pin
its new exact digest while keeping deployment.version at the high-water mark.
Old signed files and old signed rollback files fail the active digest pin. An
administrator who replaces trust can defeat this protection; ordinary users cannot.

## Inspect and diagnose

```sh
backbone policy verify /path/to/managed-policy.json
backbone policy show --json
backbone doctor --home /path/to/disposable-or-managed-home --json
```

Verify checks a candidate against current protected trust, including the active
digest pin. It does not activate an arbitrary path and cannot preflight a future
version against an unchanged deployment pin. Show needs no data folder and performs no
writes. Doctor includes a policy line with id, version and every fixed key. On a
refusal, these commands exit 1 and give a safe reason. Missing signatures, expiry,
scope mismatch and an unreadable trust file never become no policy. No artifacts
means ordinary unmanaged operation. No environment variable selects another file.

Telemetry requirements override personal endpoints; a forbidden host refuses.
Optional defaults yield to a personal endpoint or an explicit off. Mandatory
telemetry needs a host or endpoint in requirements. The Host starts it before
Core opens or governed work starts; exporter startup failure refuses work and
recovery. This guarantees startup admission, not delivery during a later collector outage. Plaintext key allowance
must be explicit in a container's actual policy; a user-controlled container
marker is never enough to weaken a requirement.

## Run the disposable proof

This uses test keys and simulated protected paths. It contacts no real provider
and touches no real data folder. The focused suite proves required precedence, editable
defaults and tamper refusal without installing system files.

```bash test
node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs node --test packages/platform/test/managed-policy.test.ts packages/platform/test/managed-policy-enforcement.test.ts packages/platform/test/managed-policy-review.test.ts packages/platform/test/managed-policy-files.test.ts packages/platform/test/managed-policy-host.test.ts
```

The CLI proof also checks the actual doctor output, policy show and all four key
entry points. These selected CLI tests refuse before opening Core and need no PostgreSQL:

```bash test
node scripts/no-leftovers.mjs node --test packages/surfaces/cli/test/policy.test.ts packages/surfaces/cli/test/policy-entrypoints.test.ts
```

The signing helper has an independent exact-byte test:

```bash test
node --test scripts/sign-managed-policy.test.mjs
```

An unmanaged owner can remove every policy artifact. A machine administrator,
a replaced runtime and hostile code in the trusted runtime process are outside
this mechanism's boundary. Use operating-system application integrity and device
management for those threats. The archived handoff records the integrations that
were applied.

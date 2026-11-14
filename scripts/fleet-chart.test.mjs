import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';

const root = resolve(import.meta.dirname, '..');
const chart = join(root, 'deploy/helm/backbone');
const read = (path) => readFileSync(join(chart, path), 'utf8');
const values = () => {const v=JSON.parse(read('values.yaml'));v.trial.plaintextKeysAcknowledged=true;v.storage.encryptionConfirmed=true;v.backups.encryptionConfirmed=true;v.network.apiServerCidrs=['10.0.0.1/32'];return v;};
const validate = new Ajv({ allErrors: true }).compile(JSON.parse(read('values.schema.json')));
const hasHelm = spawnSync('helm', ['version', '--short']).status === 0;
function render(t, change = {}, flags = [], source = chart) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'values.json');
  writeFileSync(file, JSON.stringify({ ...values(), ...change }));
  const text = execFileSync('helm', ['template', 'fleet', source, '-n', 'fleet', '-f', file, ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return text.split(/^---\s*$/m).map(s => s.replace(/^#.*$/mg, '').trim()).filter(Boolean).map(s => JSON.parse(s));
}

test('fleet values require digest pinning, distinct named homes and a bounded rollout', () => {
  assert.equal(validate(values()), true, JSON.stringify(validate.errors));
  for (const mutation of [v => v.image.digest = 'latest', v => v.homes = [], v => v.homes[0].name = '../home', v => v.rollout.timeoutSeconds = 0, v => v.homes[0].modelRoute.extra = 'secret', v => v.homes[0].policy['managed-policy.json'] = '{}']) {
    const v = values(); mutation(v); assert.equal(validate(v), false);
  }
});

test('Compose homes have separate persistent volumes and doctor health checks', () => {
  const compose = JSON.parse(readFileSync(join(root, 'deploy/compose/fleet.yaml'), 'utf8'));
  const homes = Object.values(compose.services);
  assert.ok(homes.length >= 2);
  assert.equal(new Set(homes.map(s => s.volumes.find(v => v.endsWith(':/data')))).size, homes.length);
  for (const home of homes) {
    assert.ok(home.healthcheck.test.includes('doctor'));
    assert.ok(home.environment.BACKBONE_HOME.startsWith('/data/'));
    assert.ok(home.image.includes('DIGEST:?'));
  }
});

if (hasHelm) {
  test('rendered homes are isolated single writers with retained RWO storage and real protected policy files', t => {
    const objects = render(t);
    const sets = objects.filter(o => o.kind === 'StatefulSet');
    assert.equal(sets.length, values().homes.length);
    for (const set of sets) {
      assert.equal(set.spec.replicas, 1);
      assert.equal(set.spec.updateStrategy.type, 'OnDelete');
      assert.equal(set.spec.persistentVolumeClaimRetentionPolicy.whenDeleted, 'Retain');
      assert.deepEqual(set.spec.volumeClaimTemplates[0].spec.accessModes, ['ReadWriteOnce']);
      const pod = set.spec.template.spec;
      assert.equal(pod.automountServiceAccountToken, false);
      assert.equal(pod.securityContext.fsGroup, undefined, 'volume ownership must not rewrite existing private home files');
      assert.equal(pod.containers[0].securityContext.runAsUser, 1000);
      assert.ok(pod.containers[0].readinessProbe.exec.command.includes('/fleet/ready.mjs'));
      assert.ok(pod.containers[0].volumeMounts.some(m => m.mountPath === '/etc/backbone' && m.readOnly));
      const init = pod.initContainers.find(c => c.name === 'prepare');
      assert.equal(init.securityContext.runAsUser, 0);
      assert.ok(init.command.includes('/fleet/prepare.mjs'));
      assert.ok(pod.volumes.some(v => v.name === 'policy' && v.emptyDir));
    }
    const jobs = objects.filter(o => o.kind === 'Job');
    assert.ok(jobs.some(j => j.metadata.annotations['helm.sh/hook'] === 'pre-upgrade'));
    assert.ok(jobs.some(j => j.metadata.annotations['helm.sh/hook'].includes('post-rollback')));
    for (const job of jobs) assert.equal(job.spec.backoffLimit, 0);
    const roles = objects.filter(o => o.kind === 'Role');
    assert.ok(roles.every(r => r.rules.every(rule => !rule.resources.includes('secrets'))));
  });
  test('runtime script revisions have separate ConfigMaps so unchanged pods keep their probe and startup code', t => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-chart-copy-'));
    t.after(() => rmSync(dir, {recursive:true,force:true}));
    const copy = join(dir, 'chart'); cpSync(chart, copy, {recursive:true});
    const before = render(t).find(o => o.kind === 'StatefulSet').spec.template.spec.volumes.find(v => v.name === 'runtime').configMap.name;
    const script = join(copy, 'files/ready.mjs'); writeFileSync(script, readFileSync(script,'utf8')+'\n// A new probe revision.\n');
    const objects = render(t, {}, [], copy);
    const after = objects.find(o => o.kind === 'StatefulSet').spec.template.spec.volumes.find(v => v.name === 'runtime').configMap.name;
    assert.notEqual(before, after);
    assert.ok(objects.some(o => o.kind === 'ConfigMap' && o.metadata.name === after));
  });
  test('policy signatures reach Kubernetes as the original binary bytes', t => {
    const original = Buffer.from(Array.from({length:64},(_,i)=>i*3));
    const homes=values().homes;for(const home of homes) home.policy={'managed-policy.json':'{}','policy-trust.json':'{}','managed-policy.json.sig':original.toString('base64')};
    const objects=render(t,{homes});
    const policy=objects.find(o=>o.kind==='ConfigMap' && o.metadata.name==='fleet-alpha');
    assert.deepEqual(Buffer.from(policy.binaryData?.['managed-policy.json.sig']??'','base64'),original);
    assert.equal(policy.data['managed-policy.json.sig'],undefined);
  });
  test('duplicate home names fail before Kubernetes sees colliding resources', t => {
    assert.throws(() => render(t, { homes: [values().homes[0], values().homes[0]] }), /duplicate|Command failed/);
  });
} else {
  test('Helm rendering is explicitly enabled by installing Helm', t => {
    assert.notEqual(process.env.BACKBONE_FLEET_REQUIRE_HELM, '1', 'Install Helm to run required rendering checks.');
    t.diagnostic('Helm absent: schema and Compose checked; install Helm for rendered-resource checks.');
  });
}

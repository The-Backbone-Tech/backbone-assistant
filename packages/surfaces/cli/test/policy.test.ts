import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { policyCommand } from '../src/policy.ts';
import { parse, EXIT } from '../src/commands.ts';
import { policyDescription, policyFor, ENFORCEMENT_GAPS } from '@backbone-next/platform/policy';
import { document, systemFixture } from '../../../platform/test/policy-fixture.ts';
import { freshDir } from '../../../platform/test/helpers.ts';

test('policy grammar supports show, verify and JSON without opening a home', () => {
  for (const args of [['policy', 'show'], ['policy', 'verify', 'candidate.json', '--json']]) assert.equal(parse(args).usage, undefined);
  assert.match(parse(['policy', 'verify']).usage!, /file/);
  assert.ok(parse(['policy', 'show', 'extra']).usage);
});
test('policy show and the doctor line identify id, version and fixed settings', t => {
  systemFixture(t, document({ auditContent: false }, { personRights: false }));
  const output: string[] = [];
  assert.equal(policyCommand(parse(['policy', 'show']), { out: line => output.push(line), err: line => output.push(line) }), EXIT.OK);
  assert.match(output.join('\n'), /test-company version 2/);
  assert.match(output.join('\n'), /auditContent: whether audit exports may include content = false \(fixed by policy; cannot be changed here\)/);
  assert.match(output.join('\n'), /default; personal choice takes precedence/);
  assert.match(policyDescription(policyFor('unused')).detail, /test-company version 2/);
});
test('policy verify uses protected trust; tamper and missing signatures exit refused', t => {
  const fixture = systemFixture(t);
  const output: string[] = [], io = { out: (line: string) => output.push(line), err: (line: string) => output.push(line) };
  const candidate = fixture.mapping.get(fixture.paths.policy)!;
  assert.equal(policyCommand(parse(['policy', 'verify', candidate, '--json']), io), EXIT.OK);
  assert.equal(JSON.parse(output.at(-1)!).status, 'verified');
  fixture.tamper(); assert.equal(policyCommand(parse(['policy', 'verify', candidate]), io), EXIT.REFUSED);
  fixture.remove(fixture.paths.signature); assert.equal(policyCommand(parse(['policy', 'show']), io), EXIT.REFUSED);
});
test('actual CLI dispatch and doctor have a policy result and do not initialize an absent disposable home', () => {
  const folder = freshDir('policy-cli-'), home = join(folder, 'absent');
  const main = new URL('../src/main.ts', import.meta.url).pathname;
  const show = spawnSync(process.execPath, [main, 'policy', 'show', '--home', home, '--json'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  assert.equal(show.status, 0, show.stderr); assert.equal(JSON.parse(show.stdout).status, 'none');
  const doctor = spawnSync(process.execPath, [main, 'doctor', '--home', home, '--json'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  assert.ok(doctor.stdout, doctor.stderr);
  const line = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === 'policy');
  assert.equal(line.detail, 'no managed policy');
  assert.equal(existsSync(home), false);
});

function doctorWithPolicy(t: TestContext, value: ReturnType<typeof document>, tampered = false, command = ['doctor'], env: NodeJS.ProcessEnv = {}, expected: number = EXIT.REFUSED) {
  const fixture = systemFixture(t, value);
  if (tampered) fixture.tamper();
  const root = freshDir('policy-doctor-'), home = join(root, 'absent');
  const main = new URL('../src/main.ts', import.meta.url).pathname;
  const script = `
    import fs from 'node:fs'; import cp from 'node:child_process';
    const paths = ${JSON.stringify(fixture.paths)}, mapping = new Map(${JSON.stringify([...fixture.mapping])});
    const lstat = fs.lstatSync.bind(fs), open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs), fstat = fs.fstatSync.bind(fs), exec = cp.execFileSync.bind(cp);
    const fds = new Set();
    fs.lstatSync = (p,...a) => mapping.has(String(p)) ? Object.assign(lstat(mapping.get(String(p))),{uid:0,mode:0o100644}) : [paths.root,'/Library/Application Support','/Library','/etc','/'].includes(String(p)) ? Object.assign(lstat(${JSON.stringify(root)}),{uid:0,mode:0o40755}) : lstat(p,...a);
    fs.openSync = (p,...a) => { const fd = open(mapping.get(String(p)) ?? p,...a); if(mapping.has(String(p))) fds.add(fd); return fd; };
    fs.closeSync = fd => { fds.delete(fd); close(fd); };
    fs.fstatSync = (fd,...a) => fds.has(fd) ? Object.assign(fstat(fd),{uid:0,mode:0o100644}) : fstat(fd,...a);
    cp.execFileSync = (p,a,...o) => p === '/bin/ls' && a[0] === '-lde' ? 'protected path without ACL\\n' : exec(p,a,...o);
    process.argv = [process.execPath,${JSON.stringify(main)},...${JSON.stringify(command)},'--home',${JSON.stringify(home)},'--json'];
    await import(${JSON.stringify(main)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  assert.equal(child.status, expected, child.stderr); // Only the absent home fails.
  assert.ok(child.stdout || child.stderr);
  if (command[0] === 'doctor' || tampered || expected !== EXIT.OK) assert.equal(existsSync(join(home, 'core.json')), false);
  if (command[0] !== 'doctor') return { checks: [{ name: 'work', status: expected === EXIT.OK ? 'ok' : 'fail', detail: child.stdout + child.stderr }] };
  return JSON.parse(child.stdout) as { checks: { name: string; status: string; detail: string }[] };
}

test('actual doctor dispatch names a verified system policy on a disposable simulated managed machine', t => {
  const report = doctorWithPolicy(t, document({ auditContent: false }));
  const check = report.checks.find(c => c.name === 'policy')!;
  assert.equal(check.status, 'ok'); assert.match(check.detail, /test-company version 2/); assert.match(check.detail, /auditContent/);
});
const samples: Record<keyof typeof ENFORCEMENT_GAPS, unknown> = { harnesses: ['harness-pi'], keyHolders: ['keychain'], standingSignatures: false, standingServers: [], telemetryRequired: true };
for (const section of ['requirements', 'defaults'] as const) for (const [key, value] of Object.entries(samples)) test(`doctor and show identify enforced policy for ${section}.${key}`, t => {
  const policy = document(); policy[section] = { [key]: value, ...(key === 'telemetryRequired' && section === 'requirements' ? { telemetryHost: 'collector.test' } : {}) };
  const report = doctorWithPolicy(t, policy);
  const applied = report.checks.filter(check => check.name === 'policy');
  assert.equal(applied.length, 1); assert.equal(applied[0].status, section === 'defaults' && ['standingSignatures', 'standingServers'].includes(key) ? 'warn' : 'ok');
  assert.ok(!report.checks.some(check => check.detail.includes('not enforceable in this build')));
  const lines: string[] = [];
  assert.equal(policyCommand(parse(['policy', 'show']), { out: line => lines.push(line), err: line => lines.push(line) }), EXIT.OK);
  assert.match(lines.join('\n'), /test-company version 2/);
  if (section === 'requirements') assert.ok(lines.join('\n').includes(key));

});

test('doctor prints a signature refusal once and does not relabel it as broken telemetry', t => {
  const report = doctorWithPolicy(t, document(), true);
  assert.equal(report.checks.filter(check => check.name === 'policy').length, 1);
  assert.equal(report.checks.filter(check => check.detail.includes('Managed policy refused')).length, 1);
  assert.ok(!report.checks.some(check => check.name === 'telemetry' || check.name === 'open'));
});

test('actual CLI governed work refuses a personal engine bypass and tampered policy before Core starts', t => {
  const rejected = doctorWithPolicy(t, document({ harnesses: ['harness-stub'] }), false, ['projects', 'create', 'Never created'], { BACKBONE_HARNESS: 'pi', BACKBONE_KEYS: 'plaintext' });
  assert.match(rejected.checks[0].detail, /engine is fixed by policy/);
  const tampered = doctorWithPolicy(t, document(), true, ['projects', 'create', 'Never created'], { BACKBONE_HARNESS: 'stub', BACKBONE_KEYS: 'plaintext' });
  assert.match(tampered.checks[0].detail, /signature/);
});

import { waitFor, hangDetector } from '../../../../scripts/lib/test-hang.ts';
// Consumer startup coverage: real CLI entry points, disposable homes and a loopback collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { putTelemetryEndpoint } from '@backbone-next/platform/credentials/telemetry';
import { attribute, fakeCollector } from '../../../platform/test/fake-telemetry-collector.ts';

const main = new URL('../src/main.ts', import.meta.url).href;
const moduleEntry = new URL('../../../modules/telemetry-otel/src/index.ts', import.meta.url).href;
interface Running {
  proc: ChildProcess;
  seen: { out: string; err: string };
  done: Promise<{ code: number | null; out: string; err: string }>;
}
function launch(home: string, args: string[], prefix: string[] = []): Running {
  const proc = spawn(process.execPath, [...prefix, new URL(main).pathname, ...args, '--home', home], {
    env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub', BACKBONE_USER_HOME: '', BACKBONE_MODEL_ENDPOINT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seen = { out: '', err: '' };
  proc.stdout!.on('data', chunk => seen.out += String(chunk));
  proc.stderr!.on('data', chunk => seen.err += String(chunk));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', code => resolve({ code, ...seen }));
  });
  return { proc, seen, done };
}
async function until(ok: () => boolean, child: Running): Promise<void> {
  await waitFor(()=>ok() || child.proc.exitCode !== null || child.proc.signalCode !== null,'telemetry daemon readiness',{diagnostic:()=>JSON.stringify(child.seen)});
  assert.ok(ok(), `daemon did not serve: ${child.seen.err}`);
}
async function stop(child: Running): Promise<void> {
  if (child.proc.exitCode !== null || child.proc.signalCode !== null) return;
  child.proc.kill('SIGTERM');
  let stopped = false;
  try { await hangDetector(child.done,'telemetry daemon close after SIGTERM',{diagnostic:()=>JSON.stringify(child.seen)}); stopped = true; }
  finally { if (!stopped) { child.proc.kill('SIGKILL'); await child.done; } }
  assert.ok(stopped, 'daemon did not close after SIGTERM');
}

// This wrapper observes the real module's subscription. It supplies no telemetry implementation.
function daemonProbe(home: string, record: string, absent = false): Running {
  const wrapper = `
    import { appendFileSync } from 'node:fs';
    import { startTelemetry as realStart, createExporter } from ${JSON.stringify(moduleEntry)};
    export { createExporter };
    export function startTelemetry(host, options) {
      return realStart({ call: host.call.bind(host), on(listener) {
        const off = host.on(listener);
        appendFileSync(${JSON.stringify(record)}, 'subscribed\\n');
        return off;
      } }, options);
    }
  `;
  const source = `
    import { registerHooks } from 'node:module';
    import { appendFileSync } from 'node:fs';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@backbone-next/telemetry-otel') {
        if (${absent}) {
          appendFileSync(${JSON.stringify(record)}, 'missing\\n');
          throw Object.assign(new Error('TELEMETRY_TEST_MODULE_ABSENT'), {code:'ERR_MODULE_NOT_FOUND'});
        }
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(wrapper)}`)}, shortCircuit: true };
      }
      if (specifier.startsWith('@opentelemetry/')) appendFileSync(${JSON.stringify(record)}, 'sdk\\n');
      return next(specifier, context);
    } });
    await import(${JSON.stringify(main)});
  `;
  return launch(home, ['daemon', 'run'], ['--input-type=module', '-e', source, '--']);
}
const records = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];

// Hold only the subscriber's projection, not the command's calls. No timing or collector race:
// this projection cannot finish, so the real shutdown deadline must abandon it.
function blockedTelemetrySend(home: string): Running {
  const wrapper = `
    import { startTelemetry as realStart } from ${JSON.stringify(moduleEntry)};
    export function startTelemetry(host, options) {
      return realStart({ on: host.on.bind(host), call(method, args) {
        if (method === 'threads.get') {
          process.stderr.write('fixture: telemetry projection blocked\\n');
          return new Promise(() => {});
        }
        return host.call(method, args);
      } }, options);
    }
  `;
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@backbone-next/telemetry-otel') return {
        url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(wrapper)}`)}, shortCircuit: true,
      };
      return next(specifier, context);
    } });
    await import(${JSON.stringify(main)});
  `;
  return launch(home, ['send', 'Write a brief for the deadline fixture'], ['--input-type=module', '-e', source, '--']);
}

test('CLI reports a final telemetry projection abandoned at shutdown without changing the work result', { timeout: 60_000 }, async () => {
  const home = freshDataHome('telemetry-cli-shutdown-loss'), collector = await fakeCollector();
  try {
    const project = await launch(home, ['projects', 'create', 'Telemetry deadline fixture', '--json']).done;
    assert.equal(project.code, 0, project.err);
    await putTelemetryEndpoint(home, collector.endpoint);
    const sent = await blockedTelemetrySend(home).done;
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /brief\.md/);
    assert.match(sent.err, /fixture: telemetry projection blocked/);
    assert.equal(collector.spans().filter(span => span.name === 'invoke_agent').length, 0, 'the fixture must actually prevent the final root');
    assert.match(sent.err, /Telemetry: export incomplete; observations were dropped\./, 'loss must be reported before CLI exit');
  } finally { await collector.close(); await removeDataHome(home); }
});

test('standalone CLI startup exports a completed stub turn before its Host closes', { timeout: 60_000 }, async t => {
  const home = freshDataHome('telemetry-cli-startup'), collector = await fakeCollector();
  try {
    const project = await launch(home, ['projects', 'create', 'Telemetry startup fixture', '--json']).done;
    assert.equal(project.code, 0, project.err);
    await putTelemetryEndpoint(home, collector.endpoint);
    const sent = await launch(home, ['send', 'Write a brief for the startup fixture']).done;
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /brief\.md/);
    const root = collector.spans().filter(span => span.name === 'invoke_agent');
    if (root.length !== 1) t.diagnostic(`CLI telemetry exit diagnostics: ${sent.err}`);
    assert.equal(root.length, 1, 'the CLI composition must export the final root before child process exit');
    assert.equal(root[0].parentSpanId, undefined);
    assert.equal(attribute(root[0], 'backbone.outcome'), 'done');
    assert.match(String(attribute(root[0], 'backbone.turn.id')), /^[a-f0-9-]{36}$/i);
  } finally { await collector.close(); await removeDataHome(home); }
});

test('daemon startup subscribes the real exporter when configured and loads no SDK when off', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-daemon-telemetry-probe-')), collector = await fakeCollector();
  try {
    for (const enabled of [true, false]) {
      const home = freshDataHome('telemetry-daemon-startup'), record = join(dir, enabled ? 'on' : 'off');
      let child: Running | undefined;
      try {
        if (enabled) await putTelemetryEndpoint(home, collector.endpoint);
        child = daemonProbe(home, record);
        await until(() => child!.seen.out.includes('daemon: serving'), child);
        const events = records(record);
        if (enabled) {
          assert.ok(events.includes('sdk'), 'configured daemon must load the real SDK');
          assert.equal(events.filter(event => event === 'subscribed').length, 1, 'configured daemon must actually subscribe to its Host');
        } else assert.deepEqual(events, [], 'off daemon must not resolve the optional module or SDK');
        await stop(child);
        const ended = await child.done;
        assert.equal(ended.code, 0, ended.err);
        assert.match(ended.out, /daemon: stopped/);
      } finally { if (child) await stop(child); await removeDataHome(home); }
    }
    assert.equal(collector.requests.length, 0, 'startup alone invents no turn');
  } finally { await collector.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a configured daemon keeps serving when the optional module is unavailable', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-daemon-telemetry-absent-')), home = freshDataHome('telemetry-daemon-absent');
  const collector = await fakeCollector(), record = join(dir, 'probe');
  let child: Running | undefined;
  try {
    await putTelemetryEndpoint(home, collector.endpoint);
    child = daemonProbe(home, record, true);
    await until(() => child!.seen.out.includes('daemon: serving'), child);
    assert.ok(records(record).includes('missing'), 'the test must reach the configured optional-module load');
    assert.ok(!records(record).includes('subscribed') && !records(record).includes('sdk'));
    await stop(child);
    const ended = await child.done;
    assert.equal(ended.code, 0, ended.err);
    assert.ok(!ended.err.includes('TELEMETRY_TEST_MODULE_ABSENT'));
    assert.equal(collector.requests.length, 0);
  } finally { if (child) await stop(child); await collector.close(); await removeDataHome(home); rmSync(dir, { recursive: true, force: true }); }
});
